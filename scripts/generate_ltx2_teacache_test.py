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


if __name__ == "__main__":
    unittest.main()
