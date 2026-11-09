"""Reject stale LTX CUDA environments before the UI hides Install/Repair."""

import importlib.metadata as metadata
import json
import re
import sys
from pathlib import Path


def is_current(lock):
    if sys.version_info[:2] != (3, 11) or (Path(sys.base_prefix) / "conda-meta").is_dir():
        return False
    text = lock.read_text(encoding="utf-8")
    pins = re.findall(r"^([\w.-]+)==([^\s\\;]+)", text, re.M)
    sources = re.findall(r"^(ltx-(?:core|pipelines)) @ (\S+) \\\n\s+--hash=sha256:([a-f0-9]{64})", text, re.M)
    if not pins or len(sources) != 2:
        return False
    try:
        if not all(metadata.version(name) == version for name, version in pins):
            return False
        for name, url, _digest in sources:
            dist = metadata.distribution(name)
            direct = json.loads(dist.read_text("direct_url.json") or "null")
            archive_url, subdirectory = url.split("#subdirectory=", 1)
            if (dist.version != "1.2.0" or not isinstance(direct, dict)
                    or direct.get("url") != archive_url
                    or direct.get("subdirectory") != subdirectory):
                return False
    except (metadata.PackageNotFoundError, ValueError, TypeError):
        return False
    return True


if __name__ == "__main__":
    sys.exit(0 if is_current(Path(sys.argv[1])) else 78)
