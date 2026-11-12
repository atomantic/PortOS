# Wan 2.2 CUDA runtime

Video Gen's explicit Install/Repair action installs Wan 2.2 in
`~/.portos/wan2.2-cuda/.venv`. It requires x86_64 Windows or Linux, an NVIDIA
GPU/driver compatible with CUDA 12.6, and [uv](https://docs.astral.sh/uv/).
Linux additionally requires **glibc 2.28+ and kernel 4.18+**, the minimums of
the bundled FFmpeg executable; the Torch wheel also requires glibc 2.28+.
The standard PortOS Python prerequisite still applies; uv provisions the
dedicated uv-managed CPython 3.11 automatically, without selecting Conda from
PATH. A previous runtime built with another Python minor version or a Conda base
is rebuilt in the same location; no Python path setting is
needed. Model weights remain a separate explicit download.

The installer selects `scripts/requirements-wan22-cuda-windows.lock.txt` or
`scripts/requirements-wan22-cuda-linux.lock.txt`, then runs `uv pip sync` with
`--require-hashes --only-binary :all:`. This includes torch, torchvision,
setuptools, and every transitive dependency. Sync removes packages outside the
lock during Repair. There is no separate unpinned pip/bootstrap/torch install.
The direct requirements file is an input to lock generation only.
Video Gen compares every installed dependency version with the host's lock,
including transitive packages, before treating an existing runtime as current.
An older or incomplete environment therefore offers Upgrade/Repair.

The stack is torch 2.14.1 / torchvision 0.29.1 with the `+cu126` build tag,
diffusers 0.42.0 and transformers 5.22.1. Newer transformers pins replace the old
4.x range to clear its OSV advisories. `PORTOS_TORCH_CUDA_INDEX` overrides remain
available to other runtimes; Wan rejects a different index because its locks
describe this exact CUDA stack. Changing CUDA requires regenerating and
validating both locks together.

## Regenerating locks

Edit `scripts/requirements-wan22-cuda.txt` with exact direct pins. Use
hash-verified uv **0.13.7**. The CUDA index is explicit and scoped to
**Torch and Torchvision** during resolution: its mirrors of unrelated packages can lack publication dates,
which correctly makes a global multi-index resolve fail the cooldown. Keep all
other packages on PyPI rather than dropping the cooldown.

Run from the repository root in Bash, setting `UV` to that verified executable:

```bash
set -euo pipefail
CUTOFF=2026-11-05T00:00:00Z  # advance to a UTC date at least seven days old
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
python3 - "$TMP/pyproject.toml" <<'PYPROJECT'
import json
import pathlib
import sys

lines = pathlib.Path("scripts/requirements-wan22-cuda.txt").read_text().splitlines()
deps = [line for line in lines if line and not line.startswith("#")]
pathlib.Path(sys.argv[1]).write_text(
    '[project]\nname="portos-wan22-cuda"\nversion="0.0.0"\n'
    'requires-python=">=3.11"\ndependencies=' + json.dumps(deps) + '\n'
    '[tool.uv.sources]\ntorch={index="pytorch"}\ntorchvision={index="pytorch"}\n'
    '[[tool.uv.index]]\nname="pytorch"\n'
    'url="https://download.pytorch.org/whl/cu126"\nexplicit=true\n'
)
PYPROJECT
for target in windows linux; do
  case "$target" in
    windows) platform=x86_64-pc-windows-msvc ;;
    linux) platform=x86_64-manylinux_2_28 ;;
  esac
  out="scripts/requirements-wan22-cuda-${target}.lock.txt"
  cp "$out" "$TMP/$target.lock" # retain unrelated pins during resolution
  "$UV" --no-config pip compile "$TMP/pyproject.toml" \
    --python-version 3.11 --python-platform "$platform" \
    --generate-hashes --only-binary :all: --no-header --no-annotate \
    --index-url https://pypi.org/simple --emit-index-url \
    --exclude-newer "$CUTOFF" -o "$TMP/$target.lock"
  {
    printf '# Wan 2.2 CUDA: CPython 3.11, x86_64 %s, CUDA 12.6.\n' "$target"
    printf '# uv 0.13.7; exclude-newer %s; regenerate: docs/WAN22_CUDA.md.\n' "$CUTOFF"
    # pip-format locks cannot encode uv's named explicit index. Installation
    # retains the CUDA index, but versions and allowed artifact hashes are fixed.
    printf '%s\n' '--extra-index-url https://download.pytorch.org/whl/cu126'
    cat "$TMP/$target.lock"
  } > "$out"
done
```

The temporary project derives its pins from the source requirements rather than
maintaining a second dependency list. `--no-annotate` keeps temporary filesystem
paths out of the committed locks. Torch/Torchvision's official index entries
carry SHA-256 values and upload timestamps; verify those against the lock and cutoff.
The preserved Triton entry also contains official PyTorch build hashes; verify
those against the CUDA index's `triton/` entries and their upload timestamps.
They are part of the unchanged native baseline, not new artifacts introduced
by this refresh. Verify all remaining artifacts against PyPI metadata. Never
hand-edit generated hashes.

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
