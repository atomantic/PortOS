"""Acquire the pinned AvatarForcing tensors without importing remote code."""

from __future__ import annotations

import argparse
import hashlib
import os
import tempfile
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlparse
from urllib.request import HTTPRedirectHandler, Request, build_opener


@dataclass(frozen=True)
class Artifact:
    repo: str
    revision: str
    path: str
    destination: str
    size: int
    sha256: str

    @property
    def url(self) -> str:
        return f"https://huggingface.co/{self.repo}/resolve/{self.revision}/{self.path}"


# This community mirror identifies exact Hub bytes, not an independently
# attested match to the original authors' Drive downloads.
_AVATAR = ("multimodalart/AvatarForcingHelpers", "b8c5fd3180921ecf7d70cb880099225958a047ca")
_AUDIO = ("facebook/wav2vec2-base-960h", "22aad52d435eb6dbaf354bdad9b0da84ce7d6156")
ARTIFACTS = (
    Artifact(*_AVATAR, "flow_transformer.pth", "source/flow_transformer.pth", 613993979,
             "1c258fdcc534941ef2cf46a53188690305584ca642099c523db08122e05083cc"),
    Artifact(*_AVATAR, "motion_autoencoder.pth", "source/motion_autoencoder.pth", 181034955,
             "41391516d761a3768bf43ad4ce10f41c66b3a652394610c1be2bc9617f327c33"),
    Artifact(*_AUDIO, "model.safetensors", "audio/model.safetensors", 377607901,
             "8aa76ab2243c81747a1f832954586bc566090c83a0ac167df6f31f0fa917d74a"),
    Artifact(*_AUDIO, "config.json", "audio/config.json", 1596,
             "d3ec255c063d9f95057b553b19c20135b259875834a4fe9deb218a6be25b4cf3"),
    Artifact(*_AUDIO, "preprocessor_config.json", "audio/preprocessor_config.json", 159,
             "b225d617c025463b9e157e06afea8b90dc7078fc70b013c533328423e0486b4a"),
)


def _hub_url(url: str) -> None:
    target = urlparse(url)
    host = target.hostname or ""
    if (target.scheme != "https" or target.username or target.password or
        target.port not in (None, 443) or not (
            host == "huggingface.co" or host.endswith((".hf.co", ".huggingface.co", ".hfcdn.net"))
        )):
        raise ValueError("Refusing a redirect outside Hugging Face HTTPS storage")


class HubRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        _hub_url(newurl)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def verify(path: Path, artifact: Artifact) -> None:
    if path.is_symlink() or not path.is_file() or path.stat().st_size != artifact.size:
        raise ValueError(f"{artifact.destination}: missing file or unexpected size")
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        while chunk := stream.read(1024 * 1024):
            digest.update(chunk)
    if digest.hexdigest() != artifact.sha256:
        raise ValueError(f"{artifact.destination}: SHA-256 mismatch")


def obtain(root: Path, artifact: Artifact, opener=None) -> None:
    """Verify a regular cached file or atomically admit freshly verified bytes."""
    target = root / artifact.destination
    target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    if target.parent.is_symlink() or root.is_symlink():
        raise ValueError("Refusing a symlinked weights directory")
    if target.exists() or target.is_symlink():
        if target.is_symlink() or not target.is_file():
            raise ValueError("Refusing to replace a non-regular checkpoint")
        try:
            verify(target, artifact)
            return
        except ValueError:
            target.unlink()
    _hub_url(artifact.url)
    opener = opener or build_opener(HubRedirect()).open
    fd, filename = tempfile.mkstemp(prefix=".download-", dir=target.parent)
    scratch = Path(filename)
    try:
        with os.fdopen(fd, "wb") as output, opener(Request(artifact.url), timeout=45) as response:
            _hub_url(response.geturl())
            digest = hashlib.sha256()
            count = 0
            while chunk := response.read(1024 * 1024):
                count += len(chunk)
                if count > artifact.size:
                    raise ValueError(f"{artifact.destination}: excess bytes")
                digest.update(chunk)
                output.write(chunk)
            if count != artifact.size or digest.hexdigest() != artifact.sha256:
                raise ValueError(f"{artifact.destination}: size or SHA-256 mismatch")
            output.flush()
            os.fsync(output.fileno())
        try:
            os.link(scratch, target)
        except FileExistsError:
            verify(target, artifact)
    finally:
        scratch.unlink()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["download", "verify"])
    parser.add_argument("root", type=Path)
    args = parser.parse_args()
    if args.root.is_symlink():
        parser.error("Weight root must not be a symbolic link")
    for artifact in ARTIFACTS:
        if args.action == "download":
            obtain(args.root, artifact)
        else:
            verify(args.root / artifact.destination, artifact)
        print(f"Verified {artifact.destination} ({artifact.size} bytes)", flush=True)


if __name__ == "__main__":
    main()
