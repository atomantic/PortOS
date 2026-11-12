# MuScriptor Windows/Linux runtime

The explicit MuScriptor Install/Repair action (`INSTALL_MUSCRIPTOR=1`) installs
the audio → MIDI transcription runtime in `~/.portos/venv-muscriptor`. Apple
Silicon uses its own lock (`scripts/requirements-muscriptor-mlx.lock.txt`).
Windows (Git Bash) and Linux are supported on x86_64 and need
[uv](https://docs.astral.sh/uv/), which provisions a dedicated managed CPython
3.11. Repair reuses standalone 3.11 environments and rebuilds other Python
minors or Conda-based environments, which can fail to load torch DLLs on
Windows. Intel macOS and non-x86_64 Windows/Linux hosts have no lock and are
refused.

The installer selects `scripts/requirements-muscriptor-cuda-windows.lock.txt`
or `scripts/requirements-muscriptor-cuda-linux.lock.txt` and runs
`uv pip sync --require-hashes --only-binary :all:` against the runtime
interpreter. Every distribution, including torch and its transitive CUDA
libraries, has an exact version and SHA-256 hashes. Repair removes packages
outside the lock. No pip/bootstrap upgrades run on this path. The flow is
shared with AudioLDM2 and MiniMax Music 3 CUDA (`require_cuda_lock_host` and
`sync_cuda_lock_venv` in `scripts/setup-image-video.sh`).

The direct pins (`scripts/requirements-muscriptor-cuda.txt`) are torch
2.14.1+cu126 (the build the other cu126 runtimes share), muscriptor 0.4.0 and
huggingface-hub 2.4.0 with hf-xet, matching the Apple Silicon lock's
muscriptor and hub pins. The resolved torchaudio 2.11.1 (a `py3-none` wheel
declaring `torch>=2.11`) is the version the Apple Silicon lock uses. TorchAudio
2.11 is its final maintenance line, which upstream states works with torch 2.11
and every later release, so no matched `+cu126` torchaudio build exists or is
needed. The CUDA
torch build also runs on a host without an NVIDIA GPU, so MuScriptor keeps its
CPU fallback; the readiness probe imports `TranscriptionModel` and does not
require a CUDA device. A different `PORTOS_TORCH_CUDA_INDEX` is rejected for
this runtime: changing CUDA requires regenerating and validating both locks.

Model weights remain a separate download on first transcription. Installing
and repairing never download weights or transcribe audio.

## Regenerating locks

Edit `scripts/requirements-muscriptor-cuda.txt` with exact direct pins. Use the
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

lines = pathlib.Path("scripts/requirements-muscriptor-cuda.txt").read_text().splitlines()
deps = [line for line in lines if line and not line.startswith("#")]
sources = 'torch={index="pytorch"}\n'

pathlib.Path(sys.argv[1]).write_text(
    '[project]\nname="portos-muscriptor-cuda"\nversion="0.0.0"\n'
    'requires-python=">=3.11"\ndependencies=' + json.dumps(deps) + '\n'
    '[tool.uv.sources]\n' + sources +
    '[[tool.uv.index]]\nname="pytorch"\n'
    'url="https://download.pytorch.org/whl/cu126"\nexplicit=true\n'
)
PYPROJECT
  out="scripts/requirements-muscriptor-cuda-${target}.lock.txt"
  cp "$out" "$TMP/$target.lock" # retain unrelated pins during resolution
  "$UV" --no-config pip compile "$TMP/pyproject.toml" \
    --python-version 3.11 --python-platform "$platform" \
    --generate-hashes --only-binary :all: --no-header --no-annotate \
    --index-url https://pypi.org/simple --emit-index-url \
    --exclude-newer "$CUTOFF" -o "$TMP/$target.lock"
  {
    printf '# MuScriptor CUDA: CPython 3.11, x86_64 %s, CUDA 12.6.\n' "$target"
    printf '# uv 0.13.7; exclude-newer %s; regenerate: docs/MUSCRIPTOR_CUDA.md.\n' "$CUTOFF"
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

Only Torch resolves from the CUDA index; its existing native hashes and
transitive CUDA/Triton baseline remain unchanged.

Query OSV for **every resolved package**, including `MAL-` records,
immediately before merge, using the script in
[AudioLDM2's regeneration section](./AUDIOLDM2_CUDA.md#regenerating-locks) with
`requirements-muscriptor-cuda-{target}.lock.txt` as the lock path. Any
advisory or unreadable response blocks the merge.

## Fresh install and readiness evidence

Use an isolated home/data directory to exercise the actual installer without
replacing a working runtime. From Bash, with no other runtime install flags set:

```bash
export HOME="$PWD/.cache/muscriptor-validation-home"
export PORTOS_DATA="$HOME/data"
INSTALL_MUSCRIPTOR=1 INSTALL_MFLUX=0 INSTALL_VIDEO=0 INSTALL_FLUX2=0 \
  bash scripts/setup-image-video.sh
# Repeat the same command to exercise Repair.
```

The installer's probe imports `TranscriptionModel`. On an NVIDIA host, also
run:

```bash
"$HOME/.portos/venv-muscriptor/bin/python3" -c "import torch, torchaudio; print(torch.__version__, torch.version.cuda, torch.cuda.is_available(), torchaudio.__version__)"
```

(`Scripts/python.exe` on Windows) and expect `True`. Record OS, GPU model,
driver/driver-supported CUDA, Python/torch/bundled CUDA versions, selected lock
and redacted probe output in the PR. Run `uv pip check --python` with the
installed interpreter and verify Repair leaves the lock's versions unchanged. A
Windows probe does not certify the Linux target; untested targets retain their
hardware evidence requirement. Import/readiness evidence does not claim
transcription quality or speed.
