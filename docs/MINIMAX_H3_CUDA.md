# MiniMax H3 CUDA runtime

Video Gen's explicit Install/Repair action installs the runtime in
`~/.portos/minimax-h3-cuda/.venv`. It requires x86_64 Windows or Linux, an
NVIDIA GPU/driver supporting CUDA 12.6, [uv](https://docs.astral.sh/uv/), and
the standard PortOS Python prerequisite. uv provisions managed CPython 3.11;
Repair keeps a standalone 3.11 environment and rebuilds other Python minors
or Conda-based environments in the same location. Weights and LightX2V adapters
remain separate explicit downloads; installing the runtime never renders.

Install and Repair select `scripts/requirements-minimax-h3-cuda-windows.lock.txt`
or `scripts/requirements-minimax-h3-cuda-linux.lock.txt` and run `uv pip sync
--require-hashes --only-binary :all:`. All distributions, including torch,
torchvision, torchao and transitive dependencies, have exact versions and
SHA-256 hashes. Repair removes packages outside the lock. No pip bootstrap,
unpinned upgrade or VCS install precedes sync. The direct requirements file is
only an input to regeneration.

The stack uses torch 2.14.1+cu126, torchvision 0.29.1+cu126, torchao 0.18.0,
diffusers 0.42.0 and transformers 5.22.1. Linux resolves torchao's
`0.18.0+cu126` wheel; Windows uses its `0.18.0` wheel. NumPy 2.4.6 retains
Python 3.11 support (the previous 2.5.2 pin requires Python 3.12+).
A different `PORTOS_TORCH_CUDA_INDEX` is refused for this runtime: a new CUDA
stack needs both locks regenerated and validated. Other runtimes retain their
own index policy.

## Regenerating locks

Edit `scripts/requirements-minimax-h3-cuda.txt` with exact direct pins. Use the
verified uv 0.13.7 bootstrap (`requirements-uv-bootstrap.lock.txt`), setting `UV`
to that executable. The explicit named CUDA index avoids routing unrelated
packages through PyTorch mirrors, which can lack timestamps required by the
cooldown. All other packages resolve from PyPI.

```bash
set -euo pipefail
CUTOFF=2026-11-05T00:00:00Z  # advance to a UTC date at least seven days old
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
for target in windows linux; do
  case "$target" in
    windows) platform=x86_64-pc-windows-msvc ;;
    linux) platform=x86_64-manylinux_2_28 ;;
  esac
  python3 - "$TMP/pyproject.toml" "$target" <<'PYPROJECT'
import json
import pathlib
import sys

lines = pathlib.Path("scripts/requirements-minimax-h3-cuda.txt").read_text().splitlines()
deps = [line for line in lines if line and not line.startswith("#")]
sources = 'torch={index="pytorch"}\n'
sources += 'torchvision={index="pytorch"}\n'
if sys.argv[2] == "linux":
    sources += 'torchao={index="pytorch"}\n'
pathlib.Path(sys.argv[1]).write_text(
    '[project]\nname="portos-minimax-h3-cuda"\nversion="0.0.0"\n'
    'requires-python=">=3.11"\ndependencies=' + json.dumps(deps) + '\n'
    '[tool.uv.sources]\n' + sources +
    '[[tool.uv.index]]\nname="pytorch"\n'
    'url="https://download.pytorch.org/whl/cu126"\nexplicit=true\n'
)
PYPROJECT
  out="scripts/requirements-minimax-h3-cuda-${target}.lock.txt"
  cp "$out" "$TMP/$target.lock" # retain unrelated pins during resolution
  "$UV" --no-config pip compile "$TMP/pyproject.toml" \
    --python-version 3.11 --python-platform "$platform" \
    --generate-hashes --only-binary :all: --no-header --no-annotate \
    --index-url https://pypi.org/simple --emit-index-url \
    --exclude-newer "$CUTOFF" -o "$TMP/$target.lock"
  {
    printf '# MiniMax H3 CUDA: CPython 3.11, x86_64 %s, CUDA 12.6.\n' "$target"
    printf '# uv 0.13.7; exclude-newer %s; regenerate: docs/MINIMAX_H3_CUDA.md.\n' "$CUTOFF"
    printf '%s\n' '--extra-index-url https://download.pytorch.org/whl/cu126'
    cat "$TMP/$target.lock"
  } > "$out"
done
```

The temporary project derives its pins from the source requirements. Existing
lock output preserves unrelated versions and hash sets; `--no-annotate` avoids
temporary paths in the result. The pip-format lock retains the installation
index, but every accepted artifact remains constrained by its SHA-256 hash.
Verify official CUDA-index artifact hashes and upload dates, including retained
Triton build hashes, and verify all other artifacts against PyPI. Never drop
the cutoff or hand-edit generated hashes.

This changes regeneration only. Install/Repair retains its existing
`--index-strategy unsafe-best-match` with complete `--require-hashes` locks;
that flag does not permit packages or artifacts outside the committed set.

Only Linux TorchAO is routed to the CUDA index: preserve `0.18.0+cu126` and
its existing hash there. Windows retains PyPI `0.18.0` and its two hashes.
Torch/Torchvision keep their existing official CUDA artifacts on both targets.

## Advisory checks and checkpoint containment

Immediately before merging, query OSV for every resolved package on both
targets, including `MAL-` records. This check uses only the Python standard
library, normalizes CUDA local version tags for upstream advisories, and fails
on an advisory or incomplete response:

```bash
python3 - <<'PY'
import json
import re
import urllib.request
from pathlib import Path

for target in ("windows", "linux"):
    lock = Path(f"scripts/requirements-minimax-h3-cuda-{target}.lock.txt")
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

On 2026-11-08 OSV returned no advisories for the 47 Windows and 65 Linux
packages. In particular, its
[GHSA-4j2p-28q2-5m79](https://osv.dev/vulnerability/GHSA-4j2p-28q2-5m79)
range ends at Accelerate 1.14.0; the locks select 1.15.0. This is a database
range assessment, **not evidence that upstream fixed checkpoint containment**:
static inspection of 1.15.0 still finds `load_checkpoint_in_model` joining
untrusted `weight_map` shard names to the checkpoint folder without containment
checks. Keep `scripts/_checkpoint_index_guard.py` and the runner's validation
before pipeline loading. Existing public runner regressions reject traversal,
cache-escaping symlinks and non-regular shards before the loader. Never waive
an OSV match because this guard exists; an upstream/compatibility blocker must
remain explicitly tracked and unresolved.

## Fresh install and readiness evidence

Use an isolated home and `PORTOS_DATA` directory, leaving a working runtime
untouched. Set `INSTALL_MINIMAX_H3_CUDA=1`, `INSTALL_MFLUX=0`,
`INSTALL_VIDEO=0` and `INSTALL_FLUX2=0`, then run
`bash scripts/setup-image-video.sh` (Git Bash on Windows). The required probe is:

```python
import torch, torchao
from diffusers import MiniMaxH3Transformer3DModel
from diffusers.modular_pipelines.minimax_h3 import MiniMaxH3ImageReference
assert torch.cuda.is_available()
```

Run Repair again and verify sync keeps the locked set. Record OS, GPU model,
driver, Python/torch/CUDA versions, selected lock and redacted probe output in
the PR. Keep evidence pending for any target that has not actually run; lock
resolution is not hardware validation. Do not download weights or generate.

TorchAO 0.18.0 emits upstream enum-registration deprecation warnings with this
PyTorch version. Diffusers also warns about unavailable legacy serialized
TorchAO tensor types. H3 quantizes its unquantized weights using
`Int8WeightOnlyConfig(version=2)` instead of loading those legacy objects;
the readiness imports and a small CUDA version-2 quantization probe pass on
Windows. These checks do not establish full-model render quality or speed.
