# MiniMax Music 3 CUDA runtime

Music Studio's explicit Install/Repair action installs the runtime in
`~/.portos/venv-minimax-music3`. It supports x86_64 Windows (Git Bash) and
Linux with an NVIDIA GPU/driver compatible with CUDA 12.6 and
[uv](https://docs.astral.sh/uv/). The standard PortOS Python prerequisite still
applies; uv provisions a dedicated managed CPython 3.11. Repair reuses standalone
3.11 environments and rebuilds other Python minors or Conda-based environments,
which can fail to load torch DLLs on Windows. No manual Python path is needed.

The installer selects `scripts/requirements-minimax-music3-cuda-windows.lock.txt`
or `scripts/requirements-minimax-music3-cuda-linux.lock.txt` and runs
`uv pip sync --require-hashes --only-binary :all:` against the explicit runtime
interpreter. Every distribution, including torch and its transitive CUDA
libraries, has an exact version and SHA-256 hashes. Repair removes packages
outside the lock. No pip/bootstrap upgrades or Git builds run on this path.

The stack uses torch 2.14.1+cu126, diffusers 0.42.1, transformers 5.22.1,
accelerate 1.15.0, huggingface-hub 1.33.0 and numpy 2.4.6 (the Python 3.11
compatible line). The released Diffusers wheel contains MiniMax Music 3's
modular pipeline, replacing the former Git commit install. A different
`PORTOS_TORCH_CUDA_INDEX` is rejected for this runtime: changing CUDA requires
regenerating and validating both locks. Other CUDA runtimes keep their own
installation policy.

Model weights (~29 GB) remain a separate explicit download from Music → Generate.
Installing, repairing and checking readiness never download weights or generate
music. Renderer performance/listening requirements remain in
[Music renderer benchmark evidence](features/music-renderer-benchmarks.md).

## Regenerating locks

Edit `scripts/requirements-minimax-music3-cuda.txt` with exact direct pins. Using uv
0.10.6, run from the repository root (Bash):

```bash
for target in windows linux; do
  case "$target" in
    windows) platform=x86_64-pc-windows-msvc ;;
    linux) platform=x86_64-manylinux_2_28 ;;
  esac
  uv pip compile scripts/requirements-minimax-music3-cuda.txt \
    --python-version 3.11 --python-platform "$platform" \
    --generate-hashes --only-binary :all: \
    --index-url https://pypi.org/simple \
    --extra-index-url https://download.pytorch.org/whl/cu126 \
    --index-strategy unsafe-best-match --emit-index-url \
    --no-header --annotation-style line --exclude-newer 2026-11-01 \
    -o "scripts/requirements-minimax-music3-cuda-${target}.lock.txt"
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
    lock = Path(f"scripts/requirements-minimax-music3-cuda-{target}.lock.txt")
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

Use an isolated home/data directory to exercise the actual installer without
replacing a working runtime. From Bash, with no other runtime install flags set:

```bash
export HOME="$PWD/.cache/music3-validation-home"
export PORTOS_DATA="$HOME/data"
INSTALL_MINIMAX_MUSIC3=1 INSTALL_MFLUX=0 INSTALL_VIDEO=0 INSTALL_FLUX2=0 \
  bash scripts/setup-image-video.sh
# Repeat the same command to exercise Repair.
```

The final probe imports torch, `ModularPipeline`, and `MiniMaxMusic3Blocks`, then
asserts `torch.cuda.is_available()`. Importing the concrete Music 3 blocks also
checks the released package retains this runtime's integration. Record OS,
GPU model, driver/driver-supported CUDA, Python/torch/bundled CUDA versions,
selected lock and redacted probe output in the PR. Run `uv pip check --python`
with the installed interpreter and verify Repair leaves the lock's versions
unchanged. A Windows probe does not certify the Linux target; untested targets
retain their hardware evidence requirement. Import/readiness evidence does not
claim render quality or speed.
