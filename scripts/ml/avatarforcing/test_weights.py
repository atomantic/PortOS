"""Offline unit coverage for the model download and conversion boundaries."""

from hashlib import sha256
from io import BytesIO
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

from convert import unpack_tensors
from weights import Artifact, _hub_url, obtain, verify


class FakeDownload(BytesIO):
    def geturl(self):
        return "https://cdn-lfs.huggingface.co/fixture"


class WeightsTest(unittest.TestCase):
    content = b"fixture tensors"
    artifact = Artifact("owner/repo", "test-revision", "fixture.pth", "source/fixture.pth",
                        len(content), sha256(content).hexdigest())

    def test_validates_a_download_before_it_becomes_a_cache_hit(self):
        with TemporaryDirectory() as root:
            directory = Path(root)
            obtain(directory, self.artifact, lambda *a, **kw: FakeDownload(self.content))
            verify(directory / self.artifact.destination, self.artifact)

            def unexpected(*args, **kwargs):
                self.fail("A verified cache hit must not download again")

            obtain(directory, self.artifact, unexpected)

    def test_refuses_wrong_digest_and_overlong_responses_without_cache_files(self):
        for data in (b"*" * len(self.content), self.content + b"!"):
            with self.subTest(length=len(data)), TemporaryDirectory() as root:
                with self.assertRaises(ValueError):
                    obtain(Path(root), self.artifact, lambda *a, **kw: FakeDownload(data))
                self.assertEqual(list((Path(root) / "source").iterdir()), [])

    def test_refuses_symlinked_files_and_destinations(self):
        with TemporaryDirectory() as root, TemporaryDirectory() as outside:
            directory = Path(root)
            (directory / "source").symlink_to(outside, target_is_directory=True)
            with self.assertRaises(ValueError):
                obtain(directory, self.artifact)
            self.assertEqual(list(Path(outside).iterdir()), [])

    def test_accepts_hub_storage_but_no_plain_http_other_hosts_or_credentials(self):
        for url in ("https://huggingface.co/file", "https://cas-bridge.xethub.hf.co/file"):
            _hub_url(url)
        for url in ("http://huggingface.co/file", "https://huggingface.co.example.com",
                    "https://example.com/file", "https://test@huggingface.co/file",
                    "https://huggingface.co:8080/file"):
            with self.subTest(url=url), self.assertRaises(ValueError):
                _hub_url(url)

    def test_converter_requires_a_tensor_only_dictionary(self):
        tensors = {"a": b"pretend tensor"}
        self.assertEqual(unpack_tensors({"state_dict": tensors}, bytes), tensors)
        for candidate in ({"a": 42}, {"state_dict": None}, {"": b""}, {}, ()):
            with self.subTest(candidate=candidate), self.assertRaises(ValueError):
                unpack_tensors(candidate, bytes)


if __name__ == "__main__":
    unittest.main()
