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
        def summary(strength):
            return {"name": "style.safetensors", "strength": strength, "strategy": runtime.STRATEGY_RUNTIME,
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


# --------------------------------------------------------------------------
# Block streaming (#12327). The fixtures mirror the pinned runtimes'
# ltx_core_mlx.loader.block_streaming: one shared block, rebound per index with
# load_weights(strict=True), pre-compiled with mx.compile(shared, inputs=shared),
# and a provider that falls back to the eager block under perturbations.
# --------------------------------------------------------------------------

DIM, BLOCKS = 256, 2


class StreamAttention(nn.Module):
    def __init__(self, dim):
        super().__init__()
        self.to_q = nn.Linear(dim, dim, bias=True)


class StreamBlock(nn.Module):
    """A quantized attention projection beside a float one, chainable block to block."""

    def __init__(self, dim=DIM):
        super().__init__()
        self.attn1 = StreamAttention(dim)
        self.ff = nn.Linear(dim, dim, bias=False)

    def __call__(self, x, perturbations=None):
        return self.attn1.to_q(x) + self.ff(x)


def quantize_block(block):
    nn.quantize(block, group_size=GROUP, bits=BITS, class_predicate=lambda p, m: p.endswith(("to_q", "proj_in")))
    return block


class Outer(nn.Module):
    """Non-block projections: the runtime keeps these resident beside the streamed blocks."""

    def __init__(self, dim=DIM):
        super().__init__()
        self.proj_in = nn.Linear(dim, dim, bias=False)
        self.proj_out = nn.Linear(dim, dim, bias=False)


def outer_weights(dim):
    mx.random.seed(19)
    outer = Outer(dim)
    outer.update(mlx.utils.tree_map(lambda v: mx.random.normal(v.shape) * 0.02, outer.parameters()))
    quantize_block(outer)
    mx.eval(outer.parameters())
    return mlx.utils.tree_flatten(outer.parameters())


def with_outer(model, dim, weights):
    outer = quantize_block(Outer(dim))
    outer.load_weights(weights, strict=True)
    model.proj_in, model.proj_out = outer.proj_in, outer.proj_out
    return model


def block_weights(dim, seed):
    mx.random.seed(seed)
    block = StreamBlock(dim)
    block.update(mlx.utils.tree_map(lambda v: mx.random.normal(v.shape) * 0.02, block.parameters()))
    quantize_block(block)
    mx.eval(block.parameters())
    return mlx.utils.tree_flatten(block.parameters())


def merge_requantize(weights, index, sources):
    """The runtime's per-block merge: dequantize, add the delta, quantize again."""
    merged = dict(weights)
    for source in sources:
        tensors = source.get_block_lora_dict(index)
        for key in [k for k in tensors if k.endswith(".lora_A.weight")]:
            path = key[: -len(".lora_A.weight")]
            delta = (tensors[f"{path}.lora_B.weight"] * source.strength) @ tensors[key]
            if f"{path}.scales" in merged:
                dense = mx.dequantize(merged[f"{path}.weight"], merged[f"{path}.scales"], merged[f"{path}.biases"],
                                      group_size=GROUP, bits=BITS)
                packed = mx.quantize(dense + delta, group_size=GROUP, bits=BITS)
                merged[f"{path}.weight"], merged[f"{path}.scales"], merged[f"{path}.biases"] = packed
            else:
                merged[f"{path}.weight"] = merged[f"{path}.weight"] + delta
    return list(merged.items())


class FakeBlockLoraSource:
    """``BlockLoraSource``'s surface over an already renamed adapter dict."""

    def __init__(self, tensors, strength):
        self.tensors, self.strength = tensors, strength

    def get_block_lora_dict(self, index):
        prefix = f"transformer_blocks.{index}."
        return {k[len(prefix):]: v for k, v in self.tensors.items() if k.startswith(prefix)}

    def close(self):
        pass


class FakeStreamer:
    def __init__(self, blocks):
        self.blocks = blocks
        self.bound = []

    @property
    def block_count(self):
        return len(self.blocks)

    def bind(self, block, idx, evict_previous=None, lora_sources=None):
        weights = self.blocks[idx]
        if lora_sources:
            weights = merge_requantize(weights, idx, lora_sources)
        block.load_weights(weights, strict=True)
        self.bound.append(idx)


class FakeInner(nn.Module):
    def __init__(self, shared, blocks=BLOCKS):
        super().__init__()
        self.transformer_blocks = [shared]
        self.num_layers = blocks

    def __call__(self, x, block_provider=None, perturbations=None):
        x = self.proj_in(x)
        for index in range(self.num_layers):
            block = block_provider(index)
            x = block(x) if perturbations is None else block(x, perturbations=perturbations)
        return self.proj_out(x)


class FakeStreamingLTXModel(nn.Module):
    """StreamingLTXModel at the pinned runtimes, reduced to what the adapters touch."""

    def __init__(self, model, streamer, lora_sources=None):
        super().__init__()
        self.inner = model
        shared = model.transformer_blocks[0]
        object.__setattr__(self, "_streamer", streamer)
        object.__setattr__(self, "_shared_block", shared)
        object.__setattr__(self, "_compiled_block", mx.compile(shared, inputs=shared))
        object.__setattr__(self, "_lora_sources", lora_sources or [])

    def __call__(self, *args, **kwargs):
        if kwargs.get("block_provider") is None:
            streamer = object.__getattribute__(self, "_streamer")
            shared = object.__getattribute__(self, "_shared_block")
            compiled = object.__getattribute__(self, "_compiled_block")
            lora_sources = object.__getattribute__(self, "_lora_sources")
            prev_idx = [None]
            use_compiled = kwargs.get("perturbations") is None

            def provider(idx):
                streamer.bind(shared, idx, evict_previous=prev_idx[0], lora_sources=lora_sources or None)
                prev_idx[0] = idx
                return compiled if use_compiled else shared

            kwargs["block_provider"] = provider
        return self.inner(*args, **kwargs)

    def __getattr__(self, name):
        try:
            return super().__getattr__(name)
        except AttributeError:
            return getattr(super().__getattr__("inner"), name)


class ResidentChain(nn.Module):
    """The same blocks held resident, for the resident runtime path as the reference."""

    def __init__(self, blocks, dim=DIM):
        super().__init__()
        with_outer(self, dim, outer_weights(dim))
        self.transformer_blocks = []
        for weights in blocks:
            block = quantize_block(StreamBlock(dim))
            block.load_weights(weights, strict=True)
            self.transformer_blocks.append(block)

    def __call__(self, x):
        x = self.proj_in(x)
        for block in self.transformer_blocks:
            x = block(x)
        return self.proj_out(x)


def streaming_fixture(dim=DIM, blocks=BLOCKS):
    weights = [block_weights(dim, seed=20 + i) for i in range(blocks)]
    inner = with_outer(FakeInner(quantize_block(StreamBlock(dim)), blocks), dim, outer_weights(dim))
    return FakeStreamingLTXModel(inner, FakeStreamer(weights)), weights


def block_adapter(index, path, seed, scale=1e-3, dim=DIM, rank=RANK):
    return outer_adapter(f"transformer_blocks.{index}.{path}", seed, scale, dim, rank)


def outer_adapter(target, seed, scale=1e-3, dim=DIM, rank=RANK):
    mx.random.seed(seed)
    return {
        f"{target}.lora_A.weight": mx.random.normal((rank, dim)) * scale ** 0.5,
        f"{target}.lora_B.weight": mx.random.normal((dim, rank)) * scale ** 0.5,
    }


def user_adapter():
    """Different deltas per block, on a quantized and a float projection."""
    return {**block_adapter(0, "attn1.to_q", 31), **block_adapter(1, "attn1.to_q", 32), **block_adapter(0, "ff", 33)}


def ic_adapter():
    """Only block 1 inside the stream (block 0 binds an empty slot), plus both outer kinds."""
    return {**block_adapter(1, "attn1.to_q", 41), **outer_adapter("proj_in", 42), **outer_adapter("proj_out", 43)}


def allclose(a, b):
    mx.eval(a, b)
    return float(mx.abs(a - b).max()) < 1e-4


class StreamingTest(unittest.TestCase):
    def setUp(self):
        mx.random.seed(5)
        self.x = mx.random.normal((4, DIM))

    def test_each_block_receives_only_its_own_delta_and_packed_weights_stay_put(self):
        model, weights = streaming_fixture()
        packed = [dict(block) for block in weights]
        adapters = [("user.safetensors", user_adapter(), 0.8), ("ic.safetensors", ic_adapter(), 1.0)]
        summaries = runtime.attach_adapters(model, adapters, tag="user")

        resident = ResidentChain(weights)
        runtime.attach_adapters(resident, adapters)
        plain = ResidentChain(weights)(self.x)
        expected = resident(self.x)

        # Equal to the resident path, so each block saw its own delta; the
        # runtime's compiled block would have frozen one block's arrays.
        self.assertTrue(allclose(model(self.x), expected))
        # The eager block (guidance perturbations) takes the same adapters.
        self.assertTrue(allclose(model(self.x, perturbations=object()), expected))
        self.assertFalse(allclose(expected, plain))

        self.assertEqual([s["strategy"] for s in summaries], [runtime.STRATEGY_MIXED, runtime.STRATEGY_MIXED])
        self.assertEqual([(s["quantizedTargets"], s["fusedTargets"]) for s in summaries], [(2, 1), (2, 1)])
        for before, after in zip(packed, weights):
            for key, array in before.items():
                self.assertIs(dict(after)[key], array)
        shared = model.__dict__["_shared_block"]
        self.assertIs(shared.attn1.to_q.weight, dict(weights[BLOCKS - 1])["attn1.to_q.weight"])

    def test_runtime_owned_sources_still_merge_and_the_streamer_can_be_swapped(self):
        model, weights = streaming_fixture()
        runtime.attach_adapters(model, [("user.safetensors", user_adapter(), 0.8)], tag="user")
        distilled = FakeBlockLoraSource(block_adapter(0, "attn1.to_q", 51, scale=1e-2), 0.5)
        object.__setattr__(model, "_lora_sources", [distilled])
        replacement = FakeStreamer(weights)
        object.__setattr__(model, "_streamer", replacement)
        observed = model(self.x)

        # The runtime's own merge of its distilled source, then the user delta on top.
        merged = ResidentChain([merge_requantize(w, i, [distilled]) for i, w in enumerate(weights)])
        runtime.attach_adapters(merged, [("user.safetensors", user_adapter(), 0.8)])
        self.assertEqual(replacement.bound, list(range(BLOCKS)))
        self.assertTrue(allclose(observed, merged(self.x)))

    def test_a_streaming_ic_render_drops_the_ic_adapter_for_the_clean_refine(self):
        model, weights = streaming_fixture()
        files = {"ic.safetensors": ic_adapter(), "user.safetensors": user_adapter()}
        report, statuses = runtime.AdapterReport(), []
        pipe = FakeStreamingICPipeline(model, [("ic.safetensors", 1.0)])
        runtime.install_pipeline_adapters(pipe, [("user.safetensors", 0.8)], report=report,
                                          status=statuses.append, ic=True, load_adapter=files.__getitem__)
        stage_1, stage_2 = pipe.generate(self.x)

        both = ResidentChain(weights)
        runtime.attach_adapters(both, [("u", user_adapter(), 0.8), ("i", ic_adapter(), 1.0)])
        user_only = ResidentChain(weights)
        runtime.attach_adapters(user_only, [("u", user_adapter(), 0.8)])
        self.assertTrue(allclose(stage_1, both(self.x)))
        self.assertTrue(allclose(stage_2, user_only(self.x)))
        self.assertEqual({e["role"]: e["strategy"] for e in report.entries},
                         {"user": runtime.STRATEGY_MIXED, "ic": runtime.STRATEGY_MIXED})
        self.assertEqual({e["role"]: e["stages"] for e in report.entries}, {"user": ["all"], "ic": ["stage-1"]})

        held = pipe.dit
        runtime.release_pipeline_adapters(pipe)
        self.assertIs(type(held), FakeStreamingLTXModel)
        self.assertIs(type(held.__dict__["_shared_block"].attn1.to_q), nn.QuantizedLinear)
        self.assertIs(type(held.inner.proj_in), nn.QuantizedLinear)
        self.assertEqual(runtime.runtime_adapter_targets(held), [])

    def test_streaming_validation_refuses_before_mutating(self):
        model, _weights = streaming_fixture()
        good = ("first.safetensors", user_adapter(), 1.0)
        for tensors, pattern in (
            (block_adapter(BLOCKS, "attn1.to_q", 61), "does not have"),
            (block_adapter(0, "attn1.to_q", 62, dim=DIM // 2), "do not fit"),
            (block_adapter(0, "attn1.to_k", 63), "does not have"),
        ):
            with self.assertRaisesRegex(ValueError, pattern):
                runtime.attach_adapters(model, [good, ("bad.safetensors", tensors, 1.0)])
            self.assertIs(type(model), FakeStreamingLTXModel)
            self.assertEqual(runtime.runtime_adapter_targets(model), [])

    def test_peak_memory_stays_within_the_merge_path(self):
        dim = 1024
        mx.random.seed(9)
        x = mx.random.normal((16, dim))
        tensors = {**block_adapter(0, "attn1.to_q", 71, dim=dim), **block_adapter(1, "attn1.to_q", 72, dim=dim)}

        def peak(attach):
            model, _weights = streaming_fixture(dim=dim)
            attach(model)
            mx.eval(x, *[v for v in tensors.values()])
            mx.clear_cache()
            mx.reset_peak_memory()
            baseline = mx.get_active_memory()
            mx.eval(model(x))
            return mx.get_peak_memory() - baseline

        merged = peak(lambda m: object.__setattr__(m, "_lora_sources", [FakeBlockLoraSource(tensors, 1.0)]))
        runtime_delta = peak(lambda m: runtime.attach_adapters(m, [("user.safetensors", tensors, 1.0)]))
        self.assertLessEqual(runtime_delta, merged * 1.10)


class FakeStreamingICPipeline:
    """ICLoraPipeline's streaming surface: _fuse_loras before stage 1, and a clean
    stage-2 refine that keeps the model and clears only its own _lora_sources."""

    def __init__(self, model, lora_paths):
        self.model = model
        self._lora_paths = list(lora_paths)
        self.low_ram_streaming = True
        self.dit = None
        self._loaded = False

    def _load_transformer_with_optional_streaming(self, _path):
        if getattr(self, "_pending_loras", None):
            raise AssertionError("runtime path must not hand LoRAs to the merge-and-requantize loader")
        return self.model

    def _fuse_loras(self):
        raise AssertionError("upstream bind-time merge _fuse_loras must not run")

    def _reload_clean_transformer(self):
        for source in object.__getattribute__(self.dit, "_lora_sources"):
            source.close()
        object.__setattr__(self.dit, "_lora_sources", [])

    def generate(self, x):
        self.dit = self._load_transformer_with_optional_streaming("transformer.safetensors")
        self._loaded = True
        self._fuse_loras()
        stage_1 = self.dit(x)
        self._reload_clean_transformer()
        stage_2 = self.dit(x)
        mx.eval(stage_1, stage_2)
        return stage_1, stage_2


class FakeA2vPipeline:
    def __init__(self, factory, *, reload_refine=False, failure=None, distilled=None):
        self.factory = factory
        self.distilled = distilled
        self.reload_refine = reload_refine
        self.failure = failure
        self.dit = None
        self._loaded = False
        self.distilled_calls = 0

    def _load_transformer_with_optional_streaming(self, _path):
        assert not self._pending_loras
        return self.factory()

    def _denoise_stage1(self, x):
        if self.failure == "motion":
            raise RuntimeError("motion failed")
        return self.dit(x)

    def _fuse_distilled_lora(self, dit):
        self.distilled_calls += 1
        if self.reload_refine:
            self.dit = self._load_transformer_with_optional_streaming("refine")
        if self.failure == "refine":
            raise KeyboardInterrupt("cancelled at refine")
        if self.distilled is not None:
            runtime.attach_adapters(self.dit, [("distilled.safetensors", self.distilled, 0.6)], tag="distilled")

    def generate_and_save(self, x):
        self.dit = self._load_transformer_with_optional_streaming("motion")
        self._loaded = True
        motion = self._denoise_stage1(x)
        self._fuse_distilled_lora(self.dit)
        detail = self.dit(x)
        mx.eval(motion, detail)
        return motion, detail


class A2vStageContractTest(unittest.TestCase):
    def setUp(self):
        self.device = mx.default_device()
        mx.set_default_device(mx.cpu)

    def tearDown(self):
        mx.set_default_device(self.device)

    def test_user_schedule_is_reversible_on_packed_float_and_streamed_targets_without_accumulation(self):
        # CPU-only toy projections: no model downloads or GPU allocations.
        for kind in ("packed", "float", "streamed"):
            for reload in (False, True):
                with self.subTest(kind=kind, reload=reload):
                    streamed = kind == "streamed"
                    factory = (lambda: streaming_fixture()[0]) if streamed else lambda: fixture_model(quantize=kind == "packed")
                    files = {"a/style.safetensors": user_adapter() if streamed else adapter(scale=4e-3),
                             "b/style.safetensors": ic_adapter() if streamed else adapter(scale=2e-3)}
                    specs = [("a/style.safetensors", 0.8), ("b/style.safetensors", 0.4)]
                    x = mx.ones((1, DIM if streamed else IN))
                    baseline = factory()(x)
                    full = factory()
                    runtime.attach_adapters(full, [(path, files[path], scale) for path, scale in specs])
                    expected_detail = full(x)
                    pipe, report = FakeA2vPipeline(factory, reload_refine=reload), runtime.AdapterReport()
                    restore = runtime.install_pipeline_adapters(pipe, specs, report=report, status=lambda _: None,
                                                               load_adapter=files.__getitem__, user_stage_strengths=[0, 1])
                    for _ in range(2):
                        motion, detail = pipe.generate_and_save(x)
                        self.assertTrue(allclose(motion, baseline))
                        self.assertTrue(allclose(detail, expected_detail))
                        self.assertFalse(allclose(detail, baseline))
                    self.assertEqual(pipe.distilled_calls, 2)
                    self.assertEqual(sorted((entry["strength"], entry["stages"]) for entry in report.entries),
                                     [(0.0, ["stage-1"]), (0.0, ["stage-1"]), (0.4, ["stage-2"]), (0.8, ["stage-2"])])
                    # A same-basename pair remains distinct, and no private path escapes.
                    self.assertNotIn("a/", repr(report.entries))
                    self.assertNotIn("b/", repr(report.entries))
                    if not streamed:
                        reference = factory().transformer_blocks[0].attn1.to_q
                        actual = pipe.dit.transformer_blocks[0].attn1.to_q
                        self.assertTrue(allclose(actual.weight, reference.weight))
                    restore()
                    runtime.release_pipeline_adapters(pipe)
                    self.assertIsNone(pipe.dit)
                    for name in ("_denoise_stage1", "_fuse_distilled_lora", "_load_transformer_with_optional_streaming", "_pending_loras"):
                        self.assertNotIn(name, pipe.__dict__)

    def test_stage_hooks_restore_and_release_after_failure_or_cancellation_without_retaining_a_transformer(self):
        import weakref
        import gc
        for failure in ("motion", "refine"):
            refs = []
            def factory():
                model = fixture_model()
                refs.append(weakref.ref(model))
                return model
            pipe = FakeA2vPipeline(factory, failure=failure)
            restore = runtime.install_pipeline_adapters(pipe, [("user.safetensors", 0.7)],
                report=runtime.AdapterReport(), status=lambda _: None,
                load_adapter=lambda _: adapter(), user_stage_strengths=[0.25, 0.75])
            with self.assertRaises((RuntimeError, KeyboardInterrupt)):
                try:
                    pipe.generate_and_save(mx.ones((1, IN)))
                finally:
                    restore()
                    runtime.release_pipeline_adapters(pipe)
            gc.collect()
            self.assertTrue(all(ref() is None for ref in refs))
            self.assertFalse(pipe._loaded)

    def test_stage_schedule_never_scales_the_distilled_adapter(self):
        for quantized in (False, True):
            factory = lambda: fixture_model(quantize=quantized)
            user, distilled = adapter(scale=4e-3), adapter(scale=2e-3)
            pipe = FakeA2vPipeline(factory, distilled=distilled)
            restore = runtime.install_pipeline_adapters(pipe, [("user.safetensors", 0.8)],
                report=runtime.AdapterReport(), status=lambda _: None, load_adapter=lambda _: user,
                user_stage_strengths=[0, 0])
            x = mx.ones((1, IN))
            motion, detail = pipe.generate_and_save(x)
            reference = factory()
            baseline = reference(x)
            runtime.attach_adapters(reference, [("distilled.safetensors", distilled, 0.6)])
            self.assertTrue(allclose(motion, baseline))
            self.assertTrue(allclose(detail, reference(x)))
            self.assertFalse(allclose(detail, baseline))
            restore()
            runtime.release_pipeline_adapters(pipe)

    def test_default_stage_input_keeps_legacy_fusion_and_does_not_install_stage_hooks(self):
        for strengths in (None, [1, 1]):
            pipe = FakeA2vPipeline(lambda: fixture_model(quantize=False))
            report = runtime.AdapterReport()
            restore = runtime.install_pipeline_adapters(pipe, [("user.safetensors", 0.8)],
                report=report, status=lambda _: None, load_adapter=lambda _: adapter(),
                user_stage_strengths=strengths)
            self.assertNotIn("_denoise_stage1", pipe.__dict__)
            self.assertNotIn("_fuse_distilled_lora", pipe.__dict__)
            motion, detail = pipe.generate_and_save(mx.ones((1, IN)))
            self.assertTrue(allclose(motion, detail))
            self.assertEqual(report.entries[0]["strategy"], runtime.STRATEGY_FUSED)
            self.assertEqual(report.entries[0]["stages"], ["all"])
            restore()
            runtime.release_pipeline_adapters(pipe)


if __name__ == "__main__":
    unittest.main()
