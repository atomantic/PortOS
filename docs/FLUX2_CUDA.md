# FLUX.2 Windows/Linux runtime

The explicit FLUX.2 Install/Repair action (`INSTALL_FLUX2=1`) installs the
shared FLUX.2 / Qwen-Image 2.1 / Z-Image diffusers runtime in
`~/.portos/venv-flux2`. Apple Silicon uses its own lock
(`scripts/requirements-flux2-mlx.lock.txt`). Windows (Git Bash) and Linux are
supported on x86_64 and need [uv](https://docs.astral.sh/uv/), which provisions
a dedicated managed CPython 3.11; Repair reuses standalone 3.11 environments and
rebuilds other Python minors or Conda-based environments, which can fail to load
torch DLLs on Windows. Intel macOS and non-x86_64 Windows/Linux hosts have no
lock and are refused.

The installer selects `scripts/requirements-flux2-cuda-windows.lock.txt` or
`scripts/requirements-flux2-cuda-linux.lock.txt` and runs
`uv pip sync --require-hashes --only-binary :all:` against the runtime
interpreter. Every distribution, including torch and its transitive CUDA
libraries, has an exact version and SHA-256 hashes. Repair removes packages
outside the lock. No pip/bootstrap upgrades or git sources run on this path. The
flow is shared with the other CUDA runtimes (`require_cuda_lock_host` and
`sync_cuda_lock_venv` in `scripts/setup-image-video.sh`). The in-app Image Gen
installer on Windows/Linux runs the same script instead of resolving packages
itself.

The direct pins (`scripts/requirements-flux2-cuda.txt`) are the Apple Silicon
set with torch 2.14.1+cu126 (the build the other cu126 runtimes share).
diffusers 0.42.1 is a tagged release carrying `Flux2KleinPipeline` and
`QwenImage21Pipeline` and sdnq is on PyPI, so no git source, which a hash lock
cannot express, is needed. torchvision 0.29.2 is the PyPI wheel that pairs with
that torch (no matching `+cu126` build exists). The CUDA torch build also runs on
a host without an NVIDIA GPU; the readiness probe imports the pipeline classes
and does not require a CUDA device. A different `PORTOS_TORCH_CUDA_INDEX` is
rejected: changing CUDA requires regenerating and validating both locks.

Model weights remain a separate download on first render. Installing and
repairing never download weights.

## Regenerating locks

Edit `scripts/requirements-flux2-cuda.txt` with exact direct pins. Use
hash-verified uv **0.13.7**. The CUDA index is explicit and scoped to **Torch**
during resolution: its mirrors of unrelated packages can lack publication dates,
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

lines = pathlib.Path("scripts/requirements-flux2-cuda.txt").read_text().splitlines()
deps = [line for line in lines if line and not line.startswith("#")]
pathlib.Path(sys.argv[1]).write_text(
    '[project]\nname="portos-flux2-cuda"\nversion="0.0.0"\n'
    'requires-python=">=3.11"\ndependencies=' + json.dumps(deps) + '\n'
    '[tool.uv.sources]\ntorch={index="pytorch"}\n'
    '[[tool.uv.index]]\nname="pytorch"\n'
    'url="https://download.pytorch.org/whl/cu126"\nexplicit=true\n'
)
PYPROJECT
for target in windows linux; do
  case "$target" in
    windows) platform=x86_64-pc-windows-msvc ;;
    linux) platform=x86_64-manylinux_2_28 ;;
  esac
  out="scripts/requirements-flux2-cuda-${target}.lock.txt"
  cp "$out" "$TMP/$target.lock" # retain unrelated pins during resolution
  "$UV" --no-config pip compile "$TMP/pyproject.toml" \
    --python-version 3.11 --python-platform "$platform" \
    --generate-hashes --only-binary :all: --no-header --no-annotate \
    --index-url https://pypi.org/simple --emit-index-url \
    --exclude-newer "$CUTOFF" -o "$TMP/$target.lock"
  {
    printf '# FLUX.2 CUDA: CPython 3.11, x86_64 %s, CUDA 12.6.\n' "$target"
    printf '# uv 0.13.7; exclude-newer %s; regenerate: docs/FLUX2_CUDA.md.\n' "$CUTOFF"
    # pip-format locks cannot encode uv's named explicit index. Installation
    # retains the CUDA index, but versions and allowed artifact hashes are fixed.
    printf '%s\n' '--extra-index-url https://download.pytorch.org/whl/cu126'
    cat "$TMP/$target.lock"
  } > "$out"
done
```

The temporary project derives its pins from the source requirements rather than
maintaining a second dependency list. `--no-annotate` keeps temporary filesystem
paths out of the committed locks. Torch's official simple-index entries carry
SHA-256 values and upload timestamps; verify those against the lock and cutoff.
The preserved Triton entry also contains official PyTorch build hashes; verify
those against the CUDA index's `triton/` entries and their upload timestamps.
They are part of the unchanged native baseline, not new artifacts introduced
by this refresh. Verify all remaining artifacts against PyPI metadata. Never
hand-edit generated hashes.

Query OSV for **every resolved package**, including `MAL-` records,
immediately before merge, using the script in
[AudioLDM2's regeneration section](./AUDIOLDM2_CUDA.md#regenerating-locks) with
`requirements-flux2-cuda-{target}.lock.txt` as the lock path. Any advisory or
unreadable response blocks the merge.

## Fresh install and readiness evidence

Use an isolated home/data directory to exercise the actual installer without
replacing a working runtime. From Bash, with no other runtime install flags set:

```bash
export HOME="$PWD/.cache/flux2-validation-home"
export PORTOS_DATA="$HOME/data"
INSTALL_FLUX2=1 INSTALL_MFLUX=0 INSTALL_VIDEO=0 \
  bash scripts/setup-image-video.sh
# Repeat the same command to exercise Repair.
```

The installer's probe imports `Flux2KleinPipeline` and `QwenImage21Pipeline`. On
an NVIDIA host, also run:

```bash
"$HOME/.portos/venv-flux2/bin/python3" -c "import torch; print(torch.__version__, torch.version.cuda, torch.cuda.is_available())"
```

(`Scripts/python.exe` on Windows) and expect `True`. Record OS, GPU model,
driver/driver-supported CUDA, Python/torch/bundled CUDA versions, selected lock
and redacted probe output in the PR. Run `uv pip check --python` with the
installed interpreter and verify Repair leaves the lock's versions unchanged. A
Windows probe does not certify the Linux target; untested targets retain their
hardware evidence requirement. Import/readiness evidence does not claim render
quality or speed.
