#!/usr/bin/env python3
"""Unit tests for the generate_fastvideo family split (#5860).

One venv and one repo checkout serve two FastVideo model families, but their
entry scripts do not accept the same flags. These lock the two argv shapes so a
FastH3 row can never be handed FastMetal's `--num-inference-steps` / `--fps`
(which mlx_fasth3.py rejects), and FastMetal keeps the argv it already ships.
"""
from __future__ import annotations

import importlib.util
import io
import sys
import unittest
from contextlib import redirect_stderr
from pathlib import Path
from types import SimpleNamespace

HELPER_PATH = Path(__file__).with_name("generate_fastvideo.py")


def load_helper():
    spec = importlib.util.spec_from_file_location("generate_fastvideo_under_test", HELPER_PATH)
    module = importlib.util.module_from_spec(spec)
    sys.path.insert(0, str(HELPER_PATH.parent))
    try:
        spec.loader.exec_module(module)
    finally:
        sys.path.pop(0)
    return module


def make_args(**overrides):
    args = SimpleNamespace(
        family="fastmetal",
        prompt="a paper boat on a puddle",
        negative_prompt="",
        width=832,
        height=480,
        num_frames=124,
        fps=24,
        steps=4,
        guidance=1.0,
        seed=2026,
        output="/fixture/out/render.mp4",
        image=None,
        fast=False,
        enhance_prompt=False,
        refine=False,
    )
    for key, value in overrides.items():
        setattr(args, key, value)
    return args


class BuildCommandTest(unittest.TestCase):
    def setUp(self):
        self.helper = load_helper()
        self.entry = Path("/fixture/entry.py")
        self.root = Path("/fixture/model-root")
        self.ckpt = Path("/fixture/mlx-checkpoint")

    def build(self, **overrides):
        stderr = io.StringIO()
        with redirect_stderr(stderr):
            cmd = self.helper.build_command(make_args(**overrides), self.entry, self.root, self.ckpt)
        return cmd, stderr.getvalue()

    def flag(self, cmd, name):
        return cmd[cmd.index(name) + 1]

    def test_fastmetal_keeps_its_existing_argv(self):
        cmd, _ = self.build(family="fastmetal")
        self.assertEqual(self.flag(cmd, "--num-inference-steps"), "4")
        self.assertEqual(self.flag(cmd, "--fps"), "24")
        self.assertEqual(self.flag(cmd, "--mlx-checkpoint"), str(self.ckpt))
        self.assertNotIn("--steps", cmd)

    def test_fastmetal_argv_is_byte_identical_to_the_pre_split_baseline(self):
        # The exact list this helper emitted before the family split. Pinned so
        # a later edit to the shared prefix cannot quietly reshape the argv of
        # the three FastMetal rows that already ship.
        cmd, _ = self.build(family="fastmetal")
        self.assertEqual(cmd[1:], [
            str(self.entry),
            "--model-root", str(self.root),
            "--mlx-checkpoint", str(self.ckpt),
            "--prompt", "a paper boat on a puddle",
            "--width", "832",
            "--height", "480",
            "--num-frames", "124",
            "--num-inference-steps", "4",
            "--fps", "24",
            "--seed", "2026",
            "--output-path", "/fixture/out/render.mp4",
        ])

    def test_fastmetal_forwards_its_optional_flags(self):
        cmd, _ = self.build(family="fastmetal", fast=True, enhance_prompt=True, refine=True,
                            image="/fixture/first.png")
        for flag in ("--fast", "--enhance-prompt", "--refine"):
            self.assertIn(flag, cmd)
        self.assertEqual(self.flag(cmd, "--image-path"), "/fixture/first.png")

    def test_fasth3_uses_steps_and_omits_flags_its_entry_script_lacks(self):
        cmd, _ = self.build(family="fasth3")
        self.assertEqual(self.flag(cmd, "--steps"), "4")
        self.assertEqual(self.flag(cmd, "--model-root"), str(self.root))
        self.assertEqual(self.flag(cmd, "--mlx-checkpoint"), str(self.ckpt))
        self.assertEqual(self.flag(cmd, "--output-path"), "/fixture/out/render.mp4")
        for absent in ("--num-inference-steps", "--fps", "--guidance", "--negative-prompt",
                       "--image-path", "--enhance-prompt", "--refine"):
            self.assertNotIn(absent, cmd)

    def test_fasth3_reports_rather_than_silently_dropping_unsupported_requests(self):
        cmd, stderr = self.build(family="fasth3", negative_prompt="blurry",
                                 image="/fixture/first.png", enhance_prompt=True, refine=True)
        self.assertNotIn("--negative-prompt", cmd)
        self.assertNotIn("--image-path", cmd)
        for label in ("negative prompt", "conditioning image", "prompt enhancer", "refinement pass"):
            self.assertIn(label, stderr)

    def test_fasth3_reports_a_non_native_fps_and_stays_quiet_at_24(self):
        _, noisy = self.build(family="fasth3", fps=30)
        self.assertIn("30 fps", noisy)
        _, quiet = self.build(family="fasth3", fps=self.helper.FASTH3_NATIVE_FPS)
        self.assertNotIn("fps", quiet)

    def test_fasth3_still_forwards_fast_mode(self):
        cmd, _ = self.build(family="fasth3", fast=True)
        self.assertIn("--fast", cmd)


class EntryScriptTest(unittest.TestCase):
    def setUp(self):
        self.helper = load_helper()

    def test_each_family_resolves_its_own_entry_script(self):
        import tempfile

        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            basic = repo / "examples" / "inference" / "basic"
            basic.mkdir(parents=True)
            (basic / "mlx_wan_prompt_to_video.py").write_text("")
            (basic / "mlx_fasth3.py").write_text("")

            self.assertEqual(
                self.helper.find_entry_script(repo, "fastmetal").name, "mlx_wan_prompt_to_video.py")
            self.assertEqual(
                self.helper.find_entry_script(repo, "fasth3").name, "mlx_fasth3.py")

    def test_a_checkout_without_the_fasth3_entry_script_fails_loudly(self):
        import tempfile

        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            basic = repo / "examples" / "inference" / "basic"
            basic.mkdir(parents=True)
            (basic / "mlx_wan_prompt_to_video.py").write_text("")

            with self.assertRaises(FileNotFoundError) as ctx:
                self.helper.find_entry_script(repo, "fasth3")
            self.assertIn("mlx_fasth3.py", str(ctx.exception))


if __name__ == "__main__":
    unittest.main()
