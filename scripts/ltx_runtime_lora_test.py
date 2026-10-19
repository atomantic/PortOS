#!/usr/bin/env python3
"""Contracts for ltx_runtime_lora (#12262). Needs MLX; run by ltx_runtime_lora.test.js.

The fixtures are tiny real MLX modules rather than mocks: the defect is a
numeric one (a re-quantization rounding a rank-r delta away), so only real
packed weights can show that the runtime path keeps a delta the merge loses.

Run: <mlx python> scripts/ltx_runtime_lora_test.py
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

import mlx.core as mx
import mlx.nn as nn
import mlx.utils

sys.path.insert(0, str(Path(__file__).resolve().parent))
import ltx_runtime_lora as runtime  # noqa: E402

IN, OUT, RANK, GROUP, BITS = 256, 64, 4, 64, 4
TARGET = "transformer_blocks.0.attn1.to_q"


class Attention(nn.Module):
    def __init__(self):
        super().__init__()
        self.to_q = nn.Linear(IN, OUT, bias=True)


class Block(nn.Module):
    def __init__(self):
        super().__init__()
        self.attn1 = Attention()


class TinyDiT(nn.Module):
    """The LTX key shape (`transformer_blocks.N.attn1.to_q`) at toy size."""

    def __init__(self):
        super().__init__()
        self.transformer_blocks = [Block()]

    def __call__(self, x):
        return self.transformer_blocks[0].attn1.to_q(x)


def fixture_model(*, quantize=True):
    mx.random.seed(7)
    model = TinyDiT()
    model.update(mlx.utils.tree_map(lambda v: mx.random.normal(v.shape) * 0.02, model.parameters()))
    if quantize:
        nn.quantize(model, group_size=GROUP, bits=BITS, class_predicate=lambda p, m: p.endswith("to_q"))
    mx.eval(model.parameters())
    return model


def adapter(target=TARGET, scale=1e-3, rank=RANK, out=OUT, inp=IN):
    mx.random.seed(11)
    return {
        f"{target}.lora_A.weight": mx.random.normal((rank, inp)) * scale ** 0.5,
        f"{target}.lora_B.weight": mx.random.normal((out, rank)) * scale ** 0.5,
    }


def delta_of(tensors, target=TARGET, strength=1.0):
    return (tensors[f"{target}.lora_B.weight"] * strength) @ tensors[f"{target}.lora_A.weight"]


def retention(observed, base, expected_delta):
    """Fraction of the expected output delta present in `observed - base`."""
    shift = (observed - base).flatten()
    want = expected_delta.flatten()
    return float((shift * want).sum() / (want * want).sum())


def residual(observed, base, expected_delta):
    """How far `observed` lands from `base + expected_delta`, relative to the delta."""
    return float(mx.linalg.norm(observed - base - expected_delta) / mx.linalg.norm(expected_delta))


class RetentionTest(unittest.TestCase):
    def test_quantized_projection_keeps_a_delta_that_merge_and_requantize_loses(self):
        model = fixture_model()
        q = model.transformer_blocks[0].attn1.to_q
        packed = (q.weight, q.scales, q.biases)
        x = mx.random.normal((8, IN))
        base = model(x)
        # Per-element delta ~1e-4 against weights with std 0.02: a realistic
        # adapter-to-weight ratio, and well under one q4 rounding step.
        tensors = adapter(scale=1e-4)
        expected = x @ delta_of(tensors).T

        # The control: what the runtime's apply_loras does to a q4 weight.
        dense = mx.dequantize(q.weight, q.scales, q.biases, group_size=GROUP, bits=BITS)
        merged = mx.quantize(dense + delta_of(tensors), group_size=GROUP, bits=BITS)
        control = mx.quantized_matmul(x, *merged, transpose=True, group_size=GROUP, bits=BITS) + q.bias

        [summary] = runtime.attach_adapters(model, [("ingredients.safetensors", tensors, 1.0)])
        applied = model(x)
        mx.eval(base, applied, control, expected)

        self.assertGreater(retention(applied, base, expected), 0.98)
        self.assertLess(residual(applied, base, expected), 0.02)
        # The merge keeps a small fraction of the delta and buries it in
        # re-quantization noise larger than the delta itself.
        self.assertLess(retention(control, base, expected), 0.25)
        self.assertGreater(residual(control, base, expected), 1.0)
        self.assertEqual(summary["strategy"], runtime.STRATEGY_RUNTIME)
        self.assertEqual((summary["quantizedTargets"], summary["fusedTargets"]), (1, 0))
        # The packed base and its metadata are the very arrays that were loaded.
        for before, after in zip(packed, (q.weight, q.scales, q.biases)):
            self.assertIs(before, after)
        self.assertEqual((q.group_size, q.bits), (GROUP, BITS))

    def test_parameter_tree_is_unchanged_so_later_weight_rebinds_keep_the_delta(self):
        model = fixture_model()
        names = sorted(k for k, _ in mlx.utils.tree_flatten(model.parameters()))
        tensors = adapter()
        runtime.attach_adapters(model, [("user.safetensors", tensors, 0.5)])
        self.assertEqual(sorted(k for k, _ in mlx.utils.tree_flatten(model.parameters())), names)

        # The two-stage pipelines fuse their distilled LoRA by flattening the
        # parameters and calling load_weights(strict) — the adapter must ride
        # through that rebind rather than being silently dropped by it.
        x = mx.random.normal((4, IN))
        model.load_weights(mlx.utils.tree_flatten(model.parameters()), strict=True)
        q = model.transformer_blocks[0].attn1.to_q
        plain = mx.quantized_matmul(x, q.weight, q.scales, q.biases, transpose=True,
                                    group_size=GROUP, bits=BITS) + q.bias
        observed = model(x)
        mx.eval(plain, observed)
        self.assertGreater(retention(observed, plain, x @ delta_of(tensors, strength=0.5).T), 0.98)
        self.assertEqual(runtime.runtime_adapter_targets(model), [TARGET])

    def test_float_projection_keeps_fusion(self):
        model = fixture_model(quantize=False)
        x = mx.random.normal((4, IN))
        base = model(x)
        tensors = adapter()
        [summary] = runtime.attach_adapters(model, [("user.safetensors", tensors, 1.0)])
        observed = model(x)
        mx.eval(base, observed)
        self.assertEqual(summary["strategy"], runtime.STRATEGY_FUSED)
        self.assertEqual(runtime.runtime_adapter_targets(model), [])
        self.assertGreater(retention(observed, base, x @ delta_of(tensors).T), 0.98)

    def test_detach_restores_the_plain_quantized_projection(self):
        model = fixture_model()
        x = mx.random.normal((4, IN))
        base = model(x)
        runtime.attach_adapters(model, [("user.safetensors", adapter(), 1.0)])
        self.assertEqual(runtime.detach_runtime_adapters(model), 1)
        restored = model(x)
        mx.eval(base, restored)
        self.assertIs(type(model.transformer_blocks[0].attn1.to_q), nn.QuantizedLinear)
        self.assertTrue(mx.array_equal(base, restored).item())


class ValidationTest(unittest.TestCase):
    def assert_refused(self, tensors, pattern):
        model = fixture_model()
        good = ("first.safetensors", adapter(), 1.0)
        with self.assertRaisesRegex(ValueError, pattern):
            runtime.attach_adapters(model, [good, ("bad.safetensors", tensors, 1.0)])
        # Validation precedes mutation: the valid adapter listed first was not attached.
        self.assertEqual(runtime.runtime_adapter_targets(model), [])

    def test_refuses_a_target_the_transformer_does_not_have(self):
        self.assert_refused(adapter("transformer_blocks.9.attn1.to_q"), "does not have")

    def test_refuses_a_shape_that_does_not_fit_the_projection(self):
        self.assert_refused(adapter(inp=IN // 2), "do not fit")

    def test_refuses_half_of_a_pair(self):
        tensors = adapter()
        tensors.pop(f"{TARGET}.lora_B.weight")
        self.assert_refused(tensors, "no lora_B")

    def test_refuses_tensors_outside_the_adapter_contract(self):
        tensors = adapter()
        tensors[f"{TARGET}.diff_b"] = mx.zeros((OUT,))
        self.assert_refused(tensors, "cannot apply")

    def test_refuses_a_non_linear_target(self):
        tensors = adapter("transformer_blocks.0.attn1")
        self.assert_refused(tensors, "not a linear projection")

    def test_ignores_alpha_like_the_runtime_merge(self):
        model = fixture_model()
        tensors = {**adapter(), f"{TARGET}.alpha": mx.array(8.0)}
        [summary] = runtime.attach_adapters(model, [("user.safetensors", tensors, 1.0)])
        self.assertEqual(summary["quantizedTargets"], 1)


class AdapterReportTest(unittest.TestCase):
    def test_same_basename_or_strength_change_is_a_separate_application(self):
        report = runtime.AdapterReport()
        summary = lambda strength: {"name": "style.safetensors", "strength": strength, "strategy": runtime.STRATEGY_RUNTIME,
                                    "quantizedTargets": 1, "fusedTargets": 0}
        self.assertTrue(report.record("user", "all", "a/style.safetensors", summary(0.5)))
        self.assertFalse(report.record("user", "all", "a/style.safetensors", summary(0.5)))
        self.assertTrue(report.record("user", "all", "b/style.safetensors", summary(0.5)))
        self.assertTrue(report.record("user", "all", "a/style.safetensors", summary(0.9)))
        self.assertEqual([e["strength"] for e in report.entries], [0.5, 0.5, 0.9])
        self.assertNotIn("a/", repr(report.entries))


class FakeICLoraPipeline:
    """The upstream ICLoraPipeline surface install_pipeline_adapters drives.

    Mirrors the pinned flow: generate() loads the DiT, calls _fuse_loras()
    once, denoises stage 1, then (distilled, non-dev) reloads a clean
    transformer for stage 2 through the same load method.
    """

    def __init__(self, lora_paths, *, low_ram_streaming=False, fail_in_stage_2=False):
        self._lora_paths = list(lora_paths)
        self.low_ram_streaming = low_ram_streaming
        self.fail_in_stage_2 = fail_in_stage_2
        self.dit = None
        self._loaded = False
        self.stage_targets = {}
        self.stage_outputs = {}

    def _load_transformer_with_optional_streaming(self, _path):
        if getattr(self, "_pending_loras", None):
            raise AssertionError("runtime path must not hand LoRAs to the merge-and-requantize loader")
        return fixture_model()

    def _fuse_loras(self):
        raise AssertionError("upstream merge-and-requantize _fuse_loras must not run")

    def _reload_clean_transformer(self):
        self.dit = None
        self.dit = self._load_transformer_with_optional_streaming("transformer.safetensors")

    def generate(self, x):
        self.dit = self._load_transformer_with_optional_streaming("transformer.safetensors")
        self._loaded = True
        self._fuse_loras()
        self.stage_targets[1] = runtime.runtime_adapter_targets(self.dit)
        self.stage_outputs[1] = self.dit(x)
        self._reload_clean_transformer()
        if self.fail_in_stage_2:
            raise RuntimeError("cancelled during stage 2")
        self.stage_targets[2] = runtime.runtime_adapter_targets(self.dit)
        self.stage_outputs[2] = self.dit(x)


class TwoStageContractTest(unittest.TestCase):
    def setUp(self):
        self.ic_tensors = adapter(scale=1e-3)
        self.user_tensors = adapter("transformer_blocks.0.attn1.to_q", scale=4e-3)
        self.files = {"ingredients.safetensors": self.ic_tensors, "character.safetensors": self.user_tensors}
        self.report = runtime.AdapterReport()
        self.statuses = []

    def install(self, pipe):
        runtime.install_pipeline_adapters(
            pipe, [("character.safetensors", 0.8)], report=self.report, status=self.statuses.append,
            ic=True, load_adapter=self.files.__getitem__,
        )

    def test_ingredients_conditions_stage_1_and_never_leaks_into_the_clean_refine(self):
        pipe = FakeICLoraPipeline([("ingredients.safetensors", 1.0)])
        self.install(pipe)
        x = mx.random.normal((4, IN))
        pipe.generate(x)

        clean = fixture_model()(x)
        user_only = x @ delta_of(self.user_tensors, strength=0.8).T
        both = user_only + x @ delta_of(self.ic_tensors).T
        mx.eval(clean, user_only, both, *pipe.stage_outputs.values())
        # Same projection carries both adapters in stage 1; stage 2 is the clean
        # reload plus the user adapter only.
        self.assertEqual(pipe.stage_targets, {1: [TARGET], 2: [TARGET]})
        self.assertGreater(retention(pipe.stage_outputs[1], clean, both), 0.98)
        self.assertGreater(retention(pipe.stage_outputs[2], clean, user_only), 0.98)
        stage2_shift = (pipe.stage_outputs[2] - clean - user_only).flatten()
        self.assertLess(float(mx.abs(stage2_shift).max()), 1e-3)

        by_role = {entry["role"]: entry for entry in self.report.entries}
        self.assertEqual(by_role["ic"]["stages"], ["stage-1"])
        self.assertEqual(by_role["user"]["stages"], ["all"])
        self.assertEqual(by_role["ic"]["strategy"], runtime.STRATEGY_RUNTIME)
        self.assertEqual(by_role["user"]["strength"], 0.8)

    def test_failure_mid_render_releases_the_transformer_and_its_adapters(self):
        pipe = FakeICLoraPipeline([("ingredients.safetensors", 1.0)], fail_in_stage_2=True)
        self.install(pipe)
        with self.assertRaises(RuntimeError):
            try:
                pipe.generate(mx.random.normal((4, IN)))
            finally:
                held = pipe.dit
                runtime.release_pipeline_adapters(pipe)
        self.assertIsNone(pipe.dit)
        self.assertFalse(pipe._loaded)
        self.assertEqual(runtime.runtime_adapter_targets(held), [])
        self.assertIs(type(held.transformer_blocks[0].attn1.to_q), nn.QuantizedLinear)

    def test_block_streaming_keeps_the_runtime_merge_and_says_so(self):
        pipe = FakeICLoraPipeline([("ingredients.safetensors", 1.0)], low_ram_streaming=True)
        original_fuse = pipe._fuse_loras
        self.install(pipe)
        self.assertEqual(pipe._pending_loras, [("character.safetensors", 0.8)])
        self.assertEqual(pipe._fuse_loras, original_fuse)
        self.assertEqual({e["strategy"] for e in self.report.entries}, {runtime.STRATEGY_REQUANTIZED})
        self.assertTrue(any("Block streaming" in s for s in self.statuses))


if __name__ == "__main__":
    unittest.main()
