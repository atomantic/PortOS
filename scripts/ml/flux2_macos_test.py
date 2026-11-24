"""Weightless contract checks for flux2_macos.py / flux2_quantized.py revision pinning (#18292).

Reads the sources with `ast`: nothing imports torch/diffusers or touches the network.
"""
import ast
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
REMOTE_CALLS = {"from_pretrained", "snapshot_download"}


def _calls(path):
    tree = ast.parse((HERE / path).read_text())
    for node in ast.walk(tree):
        if isinstance(node, ast.Call):
            f = node.func
            name = f.attr if isinstance(f, ast.Attribute) else getattr(f, "id", None)
            if name in REMOTE_CALLS:
                yield node, name


class Flux2RevisionContract(unittest.TestCase):
    def test_cli_accepts_revision_flags(self):
        src = (HERE / "flux2_macos.py").read_text()
        for flag in ("--revision", "--tokenizer-revision", "--base-pipeline-revision", "--kv-revision"):
            self.assertIn(f'"{flag}"', src)

    def test_every_remote_hub_call_forwards_revision(self):
        seen = 0
        for node, name in _calls("flux2_macos.py"):
            first = node.args[0] if node.args else None
            # Local-path loads (f-string off a snapshot dir, model_path) are not Hub ids.
            if isinstance(first, ast.JoinedStr) or (isinstance(first, ast.Name) and first.id == "model_path"):
                continue
            seen += 1
            self.assertIn("revision", {k.arg for k in node.keywords}, f"{name} at line {node.lineno} floats on main")
        self.assertEqual(seen, 5)

    def test_quantized_shim_refuses_unpinned_remote_ids(self):
        calls = [n for n, name in _calls("flux2_quantized.py") if name == "snapshot_download"]
        self.assertEqual(len(calls), 1)
        src = (HERE / "flux2_quantized.py").read_text()
        self.assertIn('kwargs.get("revision")', src)
        self.assertLess(src.index('kwargs.get("revision")'), src.index("snapshot_download(pretrained_model_name_or_path"))


if __name__ == "__main__":
    unittest.main()
