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

Edit `scripts/requirements-minimax-h3-cuda.txt` with exact direct pins, then use
uv 0.10.6 from the repository root (Bash):

```bash
for target in windows linux; do
  case "$target" in
    windows) platform=x86_64-pc-windows-msvc ;;
    linux) platform=x86_64-manylinux_2_28 ;;
  esac
  uv pip compile scripts/requirements-minimax-h3-cuda.txt \
    --python-version 3.11 --python-platform "$platform" \
    --generate-hashes --only-binary :all: \
    --index-url https://pypi.org/simple \
    --extra-index-url https://download.pytorch.org/whl/cu126 \
    --index-strategy unsafe-best-match --emit-index-url \
    --no-header --annotation-style line --exclude-newer 2026-11-01 \
    -o "scripts/requirements-minimax-h3-cuda-${target}.lock.txt"
done
```

Advance the cutoff to a UTC date at least seven days before the update. Keep
the target/cutoff headers when regenerating. The multi-index strategy allows
current PyPI packages alongside CUDA wheels; all installed artifacts must still
match the committed hashes. Never hand-edit resolved package versions/hashes.

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
