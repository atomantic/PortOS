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
import tempfile
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
        prompt_cache_dir="/fixture/prompt-cache",
        mlx_checkpoint_cache_dir=None,
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

    def test_fasth3_reuses_conditioning_through_a_prompt_cache(self):
        # Streaming the bf16 Qwen3-VL conditioner is half the wall clock of a
        # 124-frame render, and it recomputes the same embeddings every time.
        cmd, _ = self.build(family="fasth3")
        self.assertEqual(self.flag(cmd, "--prompt-cache-dir"), "/fixture/prompt-cache")

    def test_fasth3_falls_back_to_a_shared_cache_dir(self):
        cmd, _ = self.build(family="fasth3", prompt_cache_dir=None)
        self.assertTrue(self.flag(cmd, "--prompt-cache-dir").endswith("prompt-cache"))

    def test_fastmetal_is_not_handed_a_prompt_cache_flag(self):
        # mlx_wan_prompt_to_video.py has no such flag; passing it would turn
        # every FastMetal render into an argparse error.
        cmd, _ = self.build(family="fastmetal")
        self.assertNotIn("--prompt-cache-dir", cmd)

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


class MlxCheckpointTest(unittest.TestCase):
    """The convert-on-first-use path for FastVideo's own bf16 FastH3 snapshot."""

    def setUp(self):
        self.helper = load_helper()

    def test_the_cache_key_is_the_snapshot_not_the_repo(self):
        # Two revisions of one repo must not collide on a converted DiT, so the
        # key carries the commit sha an HF cache path ends in.
        root = self.helper.mlx_checkpoint_root
        older = root(Path("/hfcache/models--Org--Repo/snapshots/aaaa1111"))
        newer = root(Path("/hfcache/models--Org--Repo/snapshots/bbbb2222"))
        self.assertNotEqual(older, newer)
        self.assertIn("models--Org--Repo", str(older))
        self.assertIn("aaaa1111", str(older))
        # Outside the HF cache: hf prunes by blob and would not know these
        # converted files belong to that snapshot.
        self.assertNotIn("/hfcache/models--Org--Repo", str(older))

    def test_two_roots_sharing_a_readable_name_still_get_their_own_checkpoint(self):
        # A hand-placed --model-root can share both its own name and its
        # grandparent's with an unrelated snapshot. Collapsing those onto one
        # converted DiT would render the wrong weights with nothing to notice.
        first = self.helper.mlx_checkpoint_root(Path("/srv/a/models/snapshot"))
        second = self.helper.mlx_checkpoint_root(Path("/srv/b/models/snapshot"))
        self.assertNotEqual(first, second)
        self.assertIn("snapshot", first.name)
        # Stable across calls, so a second render reuses the first conversion.
        self.assertEqual(first, self.helper.mlx_checkpoint_root(Path("/srv/a/models/snapshot")))

    def test_a_directory_missing_either_file_is_not_converted(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "int4"
            out.mkdir()
            self.assertFalse(self.helper.is_converted(out))
            (out / "mlx_h3_dit.safetensors").write_text("")
            self.assertFalse(self.helper.is_converted(out))
            (out / "mlx_h3_dit.json").write_text("")
            self.assertTrue(self.helper.is_converted(out))

    def test_an_already_converted_format_is_reused_without_a_transformer(self):
        # The steady state after the user deletes the 66 GB bf16 transformer:
        # rendering must keep working off the converted DiT alone.
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp) / "mlx-checkpoints"
            model_root = Path(tmp) / "models--Org--Repo" / "snapshots" / "abc123"
            model_root.mkdir(parents=True)
            out = self.helper.mlx_checkpoint_root(model_root, base) / "int6"
            out.mkdir(parents=True)
            for name in ("mlx_h3_dit.safetensors", "mlx_h3_dit.json"):
                (out / name).write_text("")
            resolved = self.helper.ensure_mlx_checkpoint(Path(tmp), model_root, "int6", {}, base)
            self.assertEqual(resolved, out)

    def test_a_snapshot_without_a_transformer_fails_loudly(self):
        with tempfile.TemporaryDirectory() as tmp:
            model_root = Path(tmp) / "models--Org--Repo" / "snapshots" / "def456"
            model_root.mkdir(parents=True)
            with self.assertRaises(FileNotFoundError) as ctx:
                self.helper.ensure_mlx_checkpoint(Path(tmp), model_root, "int4", {}, Path(tmp) / "cache")
            self.assertIn("transformer", str(ctx.exception))


if __name__ == "__main__":
    unittest.main()
