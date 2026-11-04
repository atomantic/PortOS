#!/usr/bin/env python3
"""Exercise the guided reference-sheet seam without loading models or MLX."""
from __future__ import annotations

import sys
import types
import unittest
from types import SimpleNamespace
from unittest.mock import patch

import ltx25_reference as reference
import ltx_runtime_lora as lora

EVENTS = []


def create_noised_state(**kwargs):
    EVENTS.append(("state", kwargs))
    return kwargs


class FakePipeline:
    vae_encoder = object()

    def _load_dev_transformer(self):
        EVENTS.append(("load",))
        return "dit"

    def _fuse_distilled_lora(self, dit):
        EVENTS.append(("fuse", dit))

    def generate_two_stage(self):
        dit = self._load_dev_transformer()
        create_noised_state(conditionings=["opening-frame"], spatial_dims=(16, 7, 12), legacy_scalar_blend=True)
        create_noised_state(conditionings=[], spatial_dims=(16, 7, 12))
        self._fuse_distilled_lora(dit)
        create_noised_state(conditionings=["opening-frame"], spatial_dims=(16, 14, 24))
        create_noised_state(conditionings=[], spatial_dims=(16, 14, 24))


class BadPipeline(FakePipeline):
    def generate_two_stage(self):
        create_noised_state(conditionings=[], spatial_dims=(16, 7, 12))


class ReferenceSheetTests(unittest.TestCase):
    def setUp(self):
        EVENTS.clear()
        self.original_state = create_noised_state
        self.utils = types.ModuleType("ltx_pipelines_mlx.iclora_utils")
        self.utils.append_ic_lora_reference_video_conditionings = self.append_reference
        self.mock = types.ModuleType("ltx_runtime_lora")
        self.mock.load_ltx_adapter = lambda path: EVENTS.append(("weights", path)) or "adapter"
        self.mock.attach_adapters = lambda model, adapters, **kw: EVENTS.append(("attach", model, adapters, kw)) or [{}]
        self.mock.set_staged_adapter_multiplier = lambda model, policy, value: EVENTS.append(("multiplier", model, policy["stage"], value))
        self.modules = patch.dict(sys.modules, {"ltx_pipelines_mlx": types.ModuleType("ltx_pipelines_mlx"),
                                                "ltx_pipelines_mlx.iclora_utils": self.utils,
                                                "ltx_runtime_lora": self.mock})
        self.modules.start()
        self.addCleanup(self.modules.stop)
        self.report = SimpleNamespace(record=lambda *args: EVENTS.append(("report", *args)))
        self.kwargs = dict(adapter_path="adapter.safetensors", reference_path="sheet.mp4", strength=0.8,
                           attention_strength=0.6, num_frames=121, report=self.report,
                           status=lambda text: None)

    @staticmethod
    def append_reference(conditionings, video, **kwargs):
        EVENTS.append(("reference", video, kwargs))
        conditionings.append("sheet")

    def test_sheet_and_adapter_are_stage_one_only_and_opening_anchor_survives(self):
        pipe = FakePipeline()
        with reference.reference_sheet_conditioning(pipe, **self.kwargs):
            pipe.generate_two_stage()
        states = [event[1] for event in EVENTS if event[0] == "state"]
        self.assertEqual([state["conditionings"] for state in states],
                         [["opening-frame", "sheet"], [], ["opening-frame"], []])
        self.assertFalse(states[0]["legacy_scalar_blend"])
        ref = next(event for event in EVENTS if event[0] == "reference")
        self.assertEqual(ref[1], [("sheet.mp4", 0.8)])
        self.assertEqual((ref[2]["height"], ref[2]["width"], ref[2]["num_frames"]), (224, 384, 121))
        self.assertEqual(ref[2]["conditioning_attention_strength"], 0.6)
        self.assertLess([e[0] for e in EVENTS].index("attach"), [e[0] for e in EVENTS].index("reference"))
        self.assertLess([e[0] for e in EVENTS].index("multiplier"), [e[0] for e in EVENTS].index("fuse"))
        self.assertIn(("multiplier", "dit", "stage-2", 0.0), EVENTS)
        self.assertIs(create_noised_state, self.original_state)
        self.assertNotIn("_load_dev_transformer", pipe.__dict__)
        self.assertNotIn("_fuse_distilled_lora", pipe.__dict__)

    def test_restores_existing_hooks_when_generation_fails(self):
        pipe = FakePipeline()
        previous = lambda: "existing"
        pipe._load_dev_transformer = previous
        with self.assertRaisesRegex(RuntimeError, "failure"):
            with reference.reference_sheet_conditioning(pipe, **self.kwargs):
                raise RuntimeError("failure")
        self.assertIs(pipe._load_dev_transformer, previous)
        self.assertIs(create_noised_state, self.original_state)

    def test_rejects_short_or_incompatible_inputs_before_loading_adapter(self):
        with self.assertRaisesRegex(ValueError, "121 frames"):
            with reference.reference_sheet_conditioning(FakePipeline(), **{**self.kwargs, "num_frames": 113}):
                pass
        with self.assertRaisesRegex(ValueError, "stage order"):
            with reference.reference_sheet_conditioning(BadPipeline(), **self.kwargs):
                pass
        self.assertFalse(any(event[0] == "weights" for event in EVENTS))

    def test_stage_multiplier_only_changes_its_own_adapter(self):
        one, two = {"multiplier": 1}, {"multiplier": 1}
        first, second = ["a", "b"], ["c", "d"]
        module = SimpleNamespace()
        module.__dict__[lora._STAGED_ATTR] = [
            (first, "down1", "up1", 1, "dtype", one),
            (second, "down2", "up2", 1, "dtype", two),
        ]
        model = SimpleNamespace(named_modules=lambda: [("projection", module)])
        with patch.object(lora, "_runtime_pair", return_value=("new", "zero")):
            lora.set_staged_adapter_multiplier(model, one, 0.0)
        self.assertEqual(first, ["new", "zero"])
        self.assertEqual(second, ["c", "d"])
        self.assertEqual(two["multiplier"], 1)


if __name__ == "__main__":
    unittest.main()
