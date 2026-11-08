# Wan 2.2 CUDA runtime

Video Gen's explicit Install/Repair action installs Wan 2.2 in
`~/.portos/wan2.2-cuda/.venv`. It requires x86_64 Windows or Linux, an NVIDIA
GPU/driver compatible with CUDA 12.6, and [uv](https://docs.astral.sh/uv/).
The standard PortOS Python prerequisite still applies; uv provisions the
dedicated CPython 3.11 automatically. A previous runtime built with another
Python minor version is rebuilt in the same location; no Python path setting is
needed. Model weights remain a separate explicit download.

The installer selects `scripts/requirements-wan22-cuda-windows.lock.txt` or
`scripts/requirements-wan22-cuda-linux.lock.txt`, then runs `uv pip sync` with
`--require-hashes --only-binary :all:`. This includes torch, torchvision,
setuptools, and every transitive dependency. Sync removes packages outside the
lock during Repair. There is no separate unpinned pip/bootstrap/torch install.
The direct requirements file is an input to lock generation only.

The stack is torch 2.14.1 / torchvision 0.29.1 with the `+cu126` build tag,
diffusers 0.42.0 and transformers 5.22.1. Newer transformers pins replace the old
4.x range to clear its OSV advisories. `PORTOS_TORCH_CUDA_INDEX` overrides remain
available to other runtimes; Wan rejects a different index because its locks
describe this exact CUDA stack. Changing CUDA requires regenerating and
validating both locks together.

## Regenerating locks

Edit `scripts/requirements-wan22-cuda.txt` with exact direct pins. Using uv
0.10.6, run from the repository root (Bash):

```bash
for target in windows linux; do
  case "$target" in
    windows) platform=x86_64-pc-windows-msvc ;;
    linux) platform=x86_64-manylinux_2_28 ;;
  esac
  uv pip compile scripts/requirements-wan22-cuda.txt \
    --python-version 3.11 --python-platform "$platform" \
    --generate-hashes --only-binary :all: \
    --index-url https://pypi.org/simple \
    --extra-index-url https://download.pytorch.org/whl/cu126 \
    --index-strategy unsafe-best-match --emit-index-url \
    --no-header --annotation-style line --exclude-newer 2026-11-01 \
    -o "scripts/requirements-wan22-cuda-${target}.lock.txt"
done
```

Advance the cutoff to a UTC date at least seven days before the update. The
multi-index strategy permits current PyPI packages alongside CUDA wheels: the
PyTorch index also mirrors older non-torch packages. Installation still requires
the exact committed versions and SHA-256 hashes. See uv's
[index resolution rules](https://docs.astral.sh/uv/pip/compatibility/#packages-that-exist-on-multiple-indexes).
Keep each lock's target/cutoff header when regenerating.

Query OSV for **every resolved package**, including `MAL-` records, immediately
before merge. This standard-library Python check normalizes CUDA local build
tags to the upstream version and fails on any advisory or unreadable response:

```bash
python3 - <<'PY'
import json
import re
import urllib.request
from pathlib import Path

for target in ("windows", "linux"):
    lock = Path(f"scripts/requirements-wan22-cuda-{target}.lock.txt")
    pins = re.findall(r"^([\w.-]+)==([^\s\\;]+)", lock.read_text(), re.M)
    assert pins, f"{target}: empty lock"
    queries = [{"package": {"name": name, "ecosystem": "PyPI"},
                "version": version.split("+")[0]} for name, version in pins]
    request = urllib.request.Request(
        "https://api.osv.dev/v1/querybatch",
        json.dumps({"queries": queries}).encode(),
        {"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(request, timeout=60) as response:
        results = json.load(response)["results"]
    assert len(results) == len(pins), "incomplete OSV response"
    findings = [(pins[i], v["id"]) for i, result in enumerate(results)
                for v in result.get("vulns", [])]
    print(target, len(pins), "packages", findings)
    assert not findings, "resolve all advisories before merge"
PY
```

## Fresh install and readiness evidence

Use a fresh isolated home/data directory to exercise the actual installer without
replacing a working runtime. Set `INSTALL_WAN22_CUDA=1`, `INSTALL_MFLUX=0`,
`INSTALL_VIDEO=0`, and `INSTALL_FLUX2=0`, then run
`bash scripts/setup-image-video.sh`. Windows uses Git Bash; Linux uses Bash.
The final probe imports torch, hf_xet, AutoencoderKLWan and WanPipeline, and
asserts `torch.cuda.is_available()`. Repeat Repair to verify the locked set
remains unchanged. Do not download model weights or generate a video for this
readiness check.

Record the OS, GPU model, driver, Python/torch/CUDA versions, selected lock and
probe result in the PR. Linux/WSL may use the same physical GPU as Windows, but
both environments must install from their own lock. Hashes and imports establish
dependency/readiness compatibility; they do not claim render quality or speed.
