#!/usr/bin/env python3
"""Unit tests for generate_ltx2's IC-LoRA reference-count contract (#3112).

The reference count is a WEIGHT contract, not a preference: a weight fed the
wrong number of references produces plausible-looking garbage rather than an
error inside the pipeline. PortOS enforces it at three layers — the route, the
`icLoraArgs` arg builder, and here — and the bounds themselves come from ONE
place (`server/lib/icLoraWeights.js`), passed in as
`--ic-min-references` / `--ic-max-references` rather than duplicated as a second
table in Python. These tests cover the Python layer: that it honors whatever
bounds it is handed (so a direct/script caller is still guarded), and that it
rejects nonsense bounds instead of trusting them.

Run: python3 scripts/generate_ltx2_ic_lora_test.py
"""
from __future__ import annotations

import importlib.util
import sys
import tempfile
import types
import unittest
from pathlib import Path
from types import SimpleNamespace


HELPER_PATH = Path(__file__).with_name("generate_ltx2.py")


class RunIcLoraBoundsTest(unittest.TestCase):
    """`run_ic_lora` argument validation, with the pipeline itself faked out."""

    def setUp(self):
        self.module_name = "generate_ltx2_ic_under_test"
        self.original_modules = {
            name: sys.modules.get(name)
            for name in [
                self.module_name,
                "ltx_pipelines_mlx",
                "ltx_pipelines_mlx.ic_lora",
                "ltx_pipelines_mlx.extend",
                "ltx_pipelines_mlx.a2vid_two_stage",
                "ltx_pipelines_mlx.ti2vid_two_stages",
            ]
        }
        for name in self.original_modules:
            sys.modules.pop(name, None)

        # Minimal fake of the runtime the helper imports at module load. The
        # TeaCache patches walk these, so they must exist even though these tests
        # never reach a real generate call.
        root = types.ModuleType("ltx_pipelines_mlx")
        root.__path__ = []
        extend = types.ModuleType("ltx_pipelines_mlx.extend")
        a2v = types.ModuleType("ltx_pipelines_mlx.a2vid_two_stage")
        two_stages = types.ModuleType("ltx_pipelines_mlx.ti2vid_two_stages")
        extend.guided_denoise_loop = lambda *a, **k: None
        a2v.guided_denoise_loop = lambda *a, **k: None
        two_stages._build_teacache_controller = lambda num_steps, thresh: None

        # Records the constructor + generate kwargs so the tests can assert the
        # LoRA-channel split without a GPU.
        recorded = self.recorded = {}

        class FakeICLoraPipeline:
            def __init__(self, **kwargs):
                recorded["init"] = kwargs

            # `bind_output_fps` rebinds this to inject the output frame rate, so
            # it has to exist even though nothing decodes here.
            def _decode_and_save_video(self, video_latent, audio_latent, output_path, **kwargs):
                return output_path

            def generate_and_save(self, **kwargs):
                recorded["generate"] = kwargs
                # Captured at generate time (not construction): the real pipeline
                # reads _pending_loras when it lazily loads the DiT inside this
                # call, so that is when both channels must be populated.
                recorded["pending_loras"] = getattr(self, "_pending_loras", None)
                return kwargs.get("output_path")

        ic_lora = types.ModuleType("ltx_pipelines_mlx.ic_lora")
        ic_lora.ICLoraPipeline = FakeICLoraPipeline
        # `_resolve_pipeline` reads the class off the PACKAGE root (upstream
        # re-exports it there), so the attribute must live on `root` — a
        # submodule alone isn't what the helper looks at.
        root.ICLoraPipeline = FakeICLoraPipeline

        sys.modules["ltx_pipelines_mlx"] = root
        sys.modules["ltx_pipelines_mlx.ic_lora"] = ic_lora
        sys.modules["ltx_pipelines_mlx.extend"] = extend
        sys.modules["ltx_pipelines_mlx.a2vid_two_stage"] = a2v
        sys.modules["ltx_pipelines_mlx.ti2vid_two_stages"] = two_stages

        spec = importlib.util.spec_from_file_location(self.module_name, HELPER_PATH)
        self.helper = importlib.util.module_from_spec(spec)
        sys.modules[self.module_name] = self.helper
        spec.loader.exec_module(self.helper)

        # References must exist on disk (the helper checks), so back them with
        # real temp files.
        self.tmp = tempfile.TemporaryDirectory()
        self.refs = []
        for i in range(9):
            p = Path(self.tmp.name) / f"ref-{i}.mp4"
            p.write_bytes(b"\x00")
            self.refs.append(str(p))
        self.weight = str(Path(self.tmp.name) / "ingredients.safetensors")
        Path(self.weight).write_bytes(b"\x00")

    def tearDown(self):
        self.tmp.cleanup()
        for name, module in self.original_modules.items():
            if module is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = module

    def _args(self, *, references, lo=2, hi=8, ic_mode="ingredients", user_loras=None):
        return SimpleNamespace(
            ic_mode=ic_mode,
            ic_lora_path=self.weight,
            ic_reference=list(references),
            ic_min_references=lo,
            ic_max_references=hi,
            ic_strength=1.0,
            ic_attention_strength=None,
            ic_skip_stage_2=False,
            user_lora_specs=user_loras,
            model="/fake/model",
            gemma="google/gemma-3-1b-it",
            prompt="the owl greets the camera",
            output=str(Path(self.tmp.name) / "out.mp4"),
            height=448,
            width=704,
            num_frames=25,
            seed=1,
            steps=30,
            stage2_steps=None,
            fps=24,
        )

    def test_accepts_every_count_inside_the_2_8_range(self):
        for n in (2, 5, 8):
            with self.subTest(n=n):
                self.helper.run_ic_lora(self._args(references=self.refs[:n]))
                self.assertEqual(
                    len(self.recorded["generate"]["video_conditioning"]), n
                )

    def test_rejects_a_count_below_the_minimum(self):
        for n in (0, 1):
            with self.subTest(n=n):
                with self.assertRaises(SystemExit) as ctx:
                    self.helper.run_ic_lora(self._args(references=self.refs[:n]))
                self.assertIn("needs 2-8", str(ctx.exception))

    def test_rejects_a_count_above_the_maximum(self):
        with self.assertRaises(SystemExit) as ctx:
            self.helper.run_ic_lora(self._args(references=self.refs[:9]))
        self.assertIn("needs 2-8", str(ctx.exception))

    def test_phrases_a_single_reference_weight_as_exactly_one(self):
        # Control/Colorize pass 1/1. The message must read "exactly 1", not
        # "1-1" — it's the same phrasing the JS side produces.
        with self.assertRaises(SystemExit) as ctx:
            self.helper.run_ic_lora(
                self._args(references=self.refs[:2], lo=1, hi=1, ic_mode="control")
            )
        self.assertIn("exactly 1", str(ctx.exception))

    def test_rejects_nonsense_bounds_rather_than_trusting_them(self):
        # A caller passing min > max (or min < 1) is a bug in the caller; silently
        # honoring it would let ANY count through or reject every count.
        with self.assertRaises(SystemExit) as ctx:
            self.helper.run_ic_lora(self._args(references=self.refs[:2], lo=8, hi=2))
        self.assertIn("1 <= min <= max", str(ctx.exception))
        with self.assertRaises(SystemExit) as ctx:
            self.helper.run_ic_lora(self._args(references=self.refs[:2], lo=0, hi=8))
        self.assertIn("1 <= min <= max", str(ctx.exception))

    def test_rejects_a_reference_missing_from_disk(self):
        with self.assertRaises(SystemExit) as ctx:
            self.helper.run_ic_lora(
                self._args(references=[self.refs[0], "/nope/missing.mp4"])
            )
        self.assertIn("does not exist", str(ctx.exception))

    def test_ic_weight_rides_lora_paths_so_user_loras_stack(self):
        # The payoff of the Phase 1 channel split: the IC weight is fused via the
        # constructor's `lora_paths` (pre-Stage-1 `_fuse_loras`) while user LoRAs
        # go through `_pending_loras`, so an Ingredients x Character stack
        # COMPOSES rather than one displacing the other.
        user = [("/fake/character.safetensors", 0.9)]
        args = self._args(references=self.refs[:2], user_loras=user)
        self.helper.run_ic_lora(args)
        # IC weight → constructor `lora_paths` (fused pre-Stage-1 at strength 1.0:
        # the weight IS the mode, not a stylistic dial).
        self.assertEqual(self.recorded["init"]["lora_paths"], [(self.weight, 1.0)])
        # User LoRAs → the SEPARATE `_pending_loras` hook. Both channels populated
        # at once is the assertion that matters; one list would mean replacement.
        self.assertEqual(self.recorded["pending_loras"], user)

    def test_every_reference_carries_the_strength_dial(self):
        args = self._args(references=self.refs[:3])
        args.ic_strength = 0.6
        self.helper.run_ic_lora(args)
        self.assertEqual(
            self.recorded["generate"]["video_conditioning"],
            [(r, 0.6) for r in self.refs[:3]],
        )


if __name__ == "__main__":
    unittest.main()
