# MiniMax H3 CUDA runtime

Video Gen's explicit Install/Repair action installs the runtime in
`~/.portos/minimax-h3-cuda/.venv`. It requires x86_64 Windows or Linux, an
NVIDIA GPU/driver supporting CUDA 12.6, [uv](https://docs.astral.sh/uv/), and
the standard PortOS Python prerequisite. uv provisions managed CPython 3.11;
Repair keeps a standalone 3.11 environment and rebuilds other Python minors
or Conda-based environments in the same location. Weights and LightX2V adapters
remain separate explicit downloads; installing the runtime never renders.

Install and Repair select `scripts/ml/requirements/requirements-minimax-h3-cuda-windows.lock.txt`
or `scripts/ml/requirements/requirements-minimax-h3-cuda-linux.lock.txt` and run `uv pip sync
--require-hashes --only-binary :all:`. All distributions, including torch,
torchvision, torchao and transitive dependencies, have exact versions and
SHA-256 hashes. Repair removes packages outside the lock. No pip bootstrap,
unpinned upgrade or VCS install precedes sync. The direct requirements file is
only an input to regeneration.

The stack uses torch 2.14.1+cu126, torchvision 0.29.1+cu126, torchao 0.18.0,
diffusers 0.42.0 and transformers 5.22.2. Linux resolves torchao's
`0.18.0+cu126` wheel; Windows uses its `0.18.0` wheel. NumPy 2.4.6 retains
Python 3.11 support (the previous 2.5.2 pin requires Python 3.12+).
A different `PORTOS_TORCH_CUDA_INDEX` is refused for this runtime: a new CUDA
stack needs both locks regenerated and validated. Other runtimes retain their
own index policy.

## Regenerating locks

Edit `scripts/ml/requirements/requirements-minimax-h3-cuda.txt` with exact direct pins, then follow the [shared procedure](./RUNTIME_LOCKS.md#regenerating-locks) with these values:

```bash
SLUG=minimax-h3-cuda
LABEL="MiniMax H3 CUDA"
DOC=docs/MINIMAX_H3_CUDA.md
CUDA_SCOPED="torch torchvision"
LINUX_CUDA_SCOPED="torchao"
```

Only Linux TorchAO is routed to the CUDA index: preserve `0.18.0+cu126` and
its existing hash there. Windows retains PyPI `0.18.0` and its two hashes.
Torch/Torchvision keep their existing official CUDA artifacts on both targets.

## Advisory checks and checkpoint containment

Immediately before merging, run the shared [OSV audit](./RUNTIME_LOCKS.md#osv-audit)
with `minimax-h3-cuda` on both targets, including `MAL-` records.

On 2026-11-08 OSV returned no advisories for the 47 Windows and 65 Linux
packages. In particular, its
[GHSA-4j2p-28q2-5m79](https://osv.dev/vulnerability/GHSA-4j2p-28q2-5m79)
range ends at Accelerate 1.14.0; the locks select 1.15.0. This is a database
range assessment, **not evidence that upstream fixed checkpoint containment**:
static inspection of 1.15.0 still finds `load_checkpoint_in_model` joining
untrusted `weight_map` shard names to the checkpoint folder without containment
checks. Keep `scripts/ml/_checkpoint_index_guard.py` and the runner's validation
before pipeline loading. Existing public runner regressions reject traversal,
cache-escaping symlinks and non-regular shards before the loader. Never waive
an OSV match because this guard exists; an upstream/compatibility blocker must
remain explicitly tracked and unresolved.

## Fresh install and readiness evidence

Follow the [shared evidence procedure](./RUNTIME_LOCKS.md#fresh-install-and-readiness-evidence).
Set `INSTALL_MINIMAX_H3_CUDA=1`, `INSTALL_MFLUX=0`, `INSTALL_VIDEO=0` and
`INSTALL_FLUX2=0`, then run `bash scripts/setup-image-video.sh`. The required
probe is:

```python
import torch, torchao
from diffusers import MiniMaxH3Transformer3DModel
from diffusers.modular_pipelines.minimax_h3 import MiniMaxH3ImageReference
assert torch.cuda.is_available()
```

Run Repair again and verify sync keeps the locked set.

TorchAO 0.18.0 emits upstream enum-registration deprecation warnings with this
PyTorch version. Diffusers also warns about unavailable legacy serialized
TorchAO tensor types. H3 quantizes its unquantized weights using
`Int8WeightOnlyConfig(version=2)` instead of loading those legacy objects;
the readiness imports and a small CUDA version-2 quantization probe pass on
Windows. These checks do not establish full-model render quality or speed.
