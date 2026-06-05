#!/usr/bin/env python3
"""Unit tests for generate_ltx2 TeaCache monkey patches."""
from __future__ import annotations

import importlib.util
import sys
import types
import unittest
from types import SimpleNamespace
from pathlib import Path


HELPER_PATH = Path(__file__).with_name("generate_ltx2.py")


class GenerateLtx2TeaCacheTest(unittest.TestCase):
    def setUp(self):
        self.module_name = "generate_ltx2_under_test"
        # ExtendPipeline actually lives in ltx_pipelines_mlx.extend (NOT
        # retake), so that is the import site the patch must target — fake the
        # same module the production patch hooks.
        self.original_modules = {
            name: sys.modules.get(name)
            for name in [
                self.module_name,
                "ltx_pipelines_mlx",
                "ltx_pipelines_mlx.extend",
                "ltx_pipelines_mlx.a2vid_two_stage",
                "ltx_pipelines_mlx.ti2vid_two_stages",
            ]
        }
        for name in self.original_modules:
            sys.modules.pop(name, None)

        root = types.ModuleType("ltx_pipelines_mlx")
        root.__path__ = []
        extend = types.ModuleType("ltx_pipelines_mlx.extend")
        a2v = types.ModuleType("ltx_pipelines_mlx.a2vid_two_stage")
        two_stages = types.ModuleType("ltx_pipelines_mlx.ti2vid_two_stages")
        self.calls = []

        def extend_loop(*args, teacache=None, **kwargs):
            return {"caller": "extend", "teacache": teacache, "kwargs": kwargs}

        def a2v_loop(*args, teacache=None, **kwargs):
            return {"caller": "a2v", "teacache": teacache, "kwargs": kwargs}

        def build_teacache(num_steps, thresh):
            self.calls.append((num_steps, thresh))
            return {"num_steps": num_steps, "thresh": thresh}

        extend.guided_denoise_loop = extend_loop
        a2v.guided_denoise_loop = a2v_loop
        two_stages._build_teacache_controller = build_teacache

        sys.modules["ltx_pipelines_mlx"] = root
        sys.modules["ltx_pipelines_mlx.extend"] = extend
        sys.modules["ltx_pipelines_mlx.a2vid_two_stage"] = a2v
        sys.modules["ltx_pipelines_mlx.ti2vid_two_stages"] = two_stages
        self.extend = extend
        self.a2v = a2v

        spec = importlib.util.spec_from_file_location(self.module_name, HELPER_PATH)
        self.helper = importlib.util.module_from_spec(spec)
        sys.modules[self.module_name] = self.helper
        spec.loader.exec_module(self.helper)

    def tearDown(self):
        for name, module in self.original_modules.items():
            if module is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = module

    def test_patch_targets_the_extend_module_call_site(self):
        # Regression guard: the patch must replace guided_denoise_loop on the
        # extend module (where ExtendPipeline calls it), not some other module.
        self.assertTrue(self.helper._EXTEND_TC_PATCH_OK)
        self.assertEqual(
            self.extend.guided_denoise_loop.__name__,
            "guided_denoise_loop_with_extend_teacache",
        )
        self.assertEqual(
            self.a2v.guided_denoise_loop.__name__,
            "guided_denoise_loop_with_a2v_teacache",
        )

    def test_resolve_pipeline_prefers_new_name_then_falls_back(self):
        root = sys.modules["ltx_pipelines_mlx"]

        class NewCls:
            pass

        class LegacyCls:
            pass

        root.NewCls = NewCls
        root.LegacyCls = LegacyCls
        # New name present → wins over the legacy fallback.
        self.assertIs(self.helper._resolve_pipeline("NewCls", "LegacyCls"), NewCls)
        # New name absent → fall back to the legacy name (pre-rename pin).
        self.assertIs(self.helper._resolve_pipeline("MissingNew", "LegacyCls"), LegacyCls)

    def test_resolve_pipeline_method_presence_skips_class_without_method(self):
        root = sys.modules["ltx_pipelines_mlx"]

        class NoMethod:
            pass

        class WithMethod:
            def extend_from_video(self):
                pass

        # Both names resolve, but only the second defines the method — the
        # extend path must pick it (mirrors ExtendPipeline-without-method on a
        # pin where the method moved to RetakePipeline).
        root.NoMethod = NoMethod
        root.WithMethod = WithMethod
        chosen = self.helper._resolve_pipeline(
            "NoMethod", "WithMethod", method="extend_from_video"
        )
        self.assertIs(chosen, WithMethod)

    def test_resolve_pipeline_raises_when_no_name_resolves(self):
        with self.assertRaises(SystemExit):
            self.helper._resolve_pipeline("Nope1", "Nope2")

    def test_rate_kwarg_name_prefers_frame_rate_over_fps(self):
        def both(a, frame_rate=1, fps=2):
            pass

        def fps_only(a, fps=2):
            pass

        def kwargs_only(a, **kwargs):
            pass

        self.assertEqual(self.helper._rate_kwarg_name(both), "frame_rate")
        self.assertEqual(self.helper._rate_kwarg_name(fps_only), "fps")
        # A bare **kwargs must NOT be treated as accepting the rate.
        self.assertIsNone(self.helper._rate_kwarg_name(kwargs_only))
        self.assertEqual(self.helper._rate_kwargs(kwargs_only, 24.0), {})
        self.assertEqual(self.helper._rate_kwargs(fps_only, 24.0), {"fps": 24.0})

    def test_one_stage_kwargs_omits_num_steps_when_steps_unset(self):
        args = SimpleNamespace(
            prompt="p", output="o.mp4", height=480, width=704,
            num_frames=97, seed=42, steps=None,
        )
        kwargs = self.helper._one_stage_kwargs(args)
        self.assertNotIn("num_steps", kwargs)
        self.assertEqual(kwargs["output_path"], "o.mp4")

        args.steps = 20
        kwargs = self.helper._one_stage_kwargs(args, image="i.png")
        self.assertEqual(kwargs["num_steps"], 20)
        self.assertEqual(kwargs["image"], "i.png")

    def test_image_conditioning_empty_without_image(self):
        def gen(image=None, images=None):
            pass

        self.assertEqual(self.helper._image_conditioning_kwargs(gen, None, None), {})

    def test_image_conditioning_bare_image_when_no_strength(self):
        # No strength override → plain image= on every pin (unchanged behavior).
        def gen(image=None, images=None):
            pass

        self.assertEqual(
            self.helper._image_conditioning_kwargs(gen, "i.png", None),
            {"image": "i.png"},
        )

    def test_image_conditioning_validates_strength_range(self):
        def gen(image=None, images=None):
            pass

        with self.assertRaises(SystemExit):
            self.helper._image_conditioning_kwargs(gen, "i.png", 1.5)

    def test_image_conditioning_uses_images_with_strength_on_new_pin(self):
        # New pin: generate_and_save accepts images= AND ImageConditioningInput
        # is importable → per-image strength is carried as a field.
        args_mod = types.ModuleType("ltx_pipelines_mlx.utils.args")

        class FakeImageConditioningInput(tuple):
            def __new__(cls, path, frame_idx, strength, crf=33):
                obj = super().__new__(cls, (path, frame_idx, strength, crf))
                obj.path, obj.frame_idx, obj.strength = path, frame_idx, strength
                return obj

        args_mod.ImageConditioningInput = FakeImageConditioningInput
        utils_mod = types.ModuleType("ltx_pipelines_mlx.utils")
        saved = {
            name: sys.modules.get(name)
            for name in ("ltx_pipelines_mlx.utils", "ltx_pipelines_mlx.utils.args")
        }
        sys.modules["ltx_pipelines_mlx.utils"] = utils_mod
        sys.modules["ltx_pipelines_mlx.utils.args"] = args_mod
        try:
            def gen(prompt=None, image=None, images=None, frame_rate=None):
                pass

            out = self.helper._image_conditioning_kwargs(gen, "i.png", 0.4)
            self.assertIn("images", out)
            self.assertNotIn("image", out)
            self.assertEqual(len(out["images"]), 1)
            ici = out["images"][0]
            self.assertEqual((ici.path, ici.frame_idx, ici.strength), ("i.png", 0, 0.4))
        finally:
            for name, module in saved.items():
                if module is None:
                    sys.modules.pop(name, None)
                else:
                    sys.modules[name] = module

    def test_image_conditioning_degrades_when_no_images_param_and_no_hook(self):
        # No images= param AND no legacy VideoConditionByLatentIndex hook →
        # graceful fallback to bare image= (neither pin's strength mechanism is
        # available, so we use the default rather than dropping it silently).
        one_stage = types.ModuleType("ltx_pipelines_mlx.ti2vid_one_stage")
        saved = sys.modules.get("ltx_pipelines_mlx.ti2vid_one_stage")
        sys.modules["ltx_pipelines_mlx.ti2vid_one_stage"] = one_stage
        sys.modules["ltx_pipelines_mlx"].ti2vid_one_stage = one_stage
        try:
            def gen(image=None):
                pass

            out = self.helper._image_conditioning_kwargs(gen, "i.png", 0.4)
            self.assertEqual(out, {"image": "i.png"})
        finally:
            if saved is None:
                sys.modules.pop("ltx_pipelines_mlx.ti2vid_one_stage", None)
            else:
                sys.modules["ltx_pipelines_mlx.ti2vid_one_stage"] = saved

    def test_extend_patch_builds_stage1_teacache_from_sigmas(self):
        self.helper._EXTEND_TC_CONFIG = self.helper._teacache_config(True, True, 30)

        result = self.extend.guided_denoise_loop(sigmas=[1.0, 0.5, 0.0])

        self.assertEqual(result["teacache"], {"num_steps": 2, "thresh": None})
        self.assertEqual(self.calls, [(2, None)])

    def test_a2v_patch_uses_configured_step_count_without_sigmas(self):
        self.helper._A2V_TC_CONFIG = self.helper._teacache_config(True, True, 17)

        result = self.a2v.guided_denoise_loop()

        self.assertEqual(result["teacache"], {"num_steps": 17, "thresh": None})
        self.assertEqual(self.calls, [(17, None)])

    def test_patch_respects_disabled_config(self):
        self.helper._EXTEND_TC_CONFIG = self.helper._teacache_config(False, True, 30)

        result = self.extend.guided_denoise_loop(sigmas=[1.0, 0.0])

        self.assertIsNone(result["teacache"])
        self.assertEqual(self.calls, [])

    def test_config_disabled_when_patch_unavailable(self):
        # patch_ok=False is the "import failed, patch never installed" gate —
        # enable must collapse to False so we never claim acceleration the
        # patched loop can't deliver.
        config = self.helper._teacache_config(True, False, 30)
        self.assertFalse(config["enable"])

        self.helper._EXTEND_TC_CONFIG = config
        result = self.extend.guided_denoise_loop(sigmas=[1.0, 0.5, 0.0])

        self.assertIsNone(result["teacache"])
        self.assertEqual(self.calls, [])

    def test_explicit_thresh_overrides_upstream_default(self):
        self.helper._A2V_TC_CONFIG = self.helper._teacache_config(True, True, 10, thresh=1.5)

        result = self.a2v.guided_denoise_loop(sigmas=[1.0, 0.5, 0.0])

        self.assertEqual(result["teacache"], {"num_steps": 2, "thresh": 1.5})
        self.assertEqual(self.calls, [(2, 1.5)])

    def test_run_extend_clears_config_even_when_pipeline_raises(self):
        # The per-call config gate must reset on every exit path so it can't
        # leak TeaCache activation into a later, unrelated call.
        memory = types.ModuleType("ltx_core_mlx.utils.memory")
        memory.aggressive_cleanup = lambda: None
        utils = types.ModuleType("ltx_core_mlx.utils")
        utils.memory = memory
        core = types.ModuleType("ltx_core_mlx")
        core.utils = utils
        injected = {
            "ltx_core_mlx": core,
            "ltx_core_mlx.utils": utils,
            "ltx_core_mlx.utils.memory": memory,
        }
        saved = {name: sys.modules.get(name) for name in injected}
        sys.modules.update(injected)

        class BoomPipeline:
            def __init__(self, **kwargs):
                pass

            def extend_from_video(self, **kwargs):
                raise RuntimeError("boom")

        self.extend.guided_denoise_loop  # ensure patched module is loaded
        sys.modules["ltx_pipelines_mlx"].ExtendPipeline = BoomPipeline

        args = SimpleNamespace(
            model="m", gemma="g", extend_from_video="in.mp4", prompt="p",
            extend_frames=2, extend_direction="after", seed=0, steps=None,
            cfg_scale=None, no_teacache=False, teacache_thresh=None,
        )
        try:
            self.helper._EXTEND_TC_CONFIG = None
            with self.assertRaises(RuntimeError):
                self.helper.run_extend(args)
            self.assertIsNone(self.helper._EXTEND_TC_CONFIG)
        finally:
            for name, module in saved.items():
                if module is None:
                    sys.modules.pop(name, None)
                else:
                    sys.modules[name] = module


class GenerateLtx2NewPinTeaCacheTest(unittest.TestCase):
    """v0.14.x deletes the `extend` module and runs extend through `retake`.

    The TeaCache patch must follow the guided_denoise_loop call site to the
    retake module via _first_module_with_attr — otherwise TeaCache silently
    no-ops on the new pin. This fakes the new-pin module shape (no `extend`,
    `retake` carries the loop) and asserts the patch lands on retake.
    """

    def setUp(self):
        self.module_name = "generate_ltx2_newpin_under_test"
        self.original_modules = {
            name: sys.modules.get(name)
            for name in [
                self.module_name,
                "ltx_pipelines_mlx",
                "ltx_pipelines_mlx.extend",
                "ltx_pipelines_mlx.retake",
                "ltx_pipelines_mlx.a2vid_two_stage",
                "ltx_pipelines_mlx.ti2vid_two_stages",
            ]
        }
        for name in self.original_modules:
            sys.modules.pop(name, None)

        root = types.ModuleType("ltx_pipelines_mlx")
        root.__path__ = []
        retake = types.ModuleType("ltx_pipelines_mlx.retake")
        a2v = types.ModuleType("ltx_pipelines_mlx.a2vid_two_stage")
        two_stages = types.ModuleType("ltx_pipelines_mlx.ti2vid_two_stages")

        def retake_loop(*args, teacache=None, **kwargs):
            return {"caller": "retake", "teacache": teacache, "kwargs": kwargs}

        def a2v_loop(*args, teacache=None, **kwargs):
            return {"caller": "a2v", "teacache": teacache, "kwargs": kwargs}

        retake.guided_denoise_loop = retake_loop
        a2v.guided_denoise_loop = a2v_loop
        two_stages._build_teacache_controller = lambda num_steps, thresh: {
            "num_steps": num_steps, "thresh": thresh,
        }

        sys.modules["ltx_pipelines_mlx"] = root
        # No ltx_pipelines_mlx.extend — exactly as v0.14.x ships.
        sys.modules["ltx_pipelines_mlx.retake"] = retake
        sys.modules["ltx_pipelines_mlx.a2vid_two_stage"] = a2v
        sys.modules["ltx_pipelines_mlx.ti2vid_two_stages"] = two_stages
        self.retake = retake
        self.a2v = a2v

        spec = importlib.util.spec_from_file_location(self.module_name, HELPER_PATH)
        self.helper = importlib.util.module_from_spec(spec)
        sys.modules[self.module_name] = self.helper
        spec.loader.exec_module(self.helper)

    def tearDown(self):
        for name, module in self.original_modules.items():
            if module is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = module

    def test_patch_follows_extend_loop_to_retake_when_extend_module_gone(self):
        self.assertTrue(self.helper._EXTEND_TC_PATCH_OK)
        self.assertEqual(
            self.retake.guided_denoise_loop.__name__,
            "guided_denoise_loop_with_extend_teacache",
        )
        self.assertEqual(
            self.a2v.guided_denoise_loop.__name__,
            "guided_denoise_loop_with_a2v_teacache",
        )


if __name__ == "__main__":
    unittest.main()
