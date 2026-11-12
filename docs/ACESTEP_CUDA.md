# ACE-Step Windows/Linux runtime

The explicit ACE-Step Install/Repair action (`INSTALL_ACESTEP=1`) installs the
full-song music runtime in `~/.portos/venv-acestep`. Apple Silicon uses its own
lock (`scripts/requirements-acestep-mlx.lock.txt`). Windows (Git Bash) and Linux
are supported on x86_64 and need [uv](https://docs.astral.sh/uv/), which
provisions a dedicated managed CPython 3.11; Repair rebuilds other Python minors
and Conda-based environments. Intel macOS and non-x86_64 Windows/Linux hosts
have no lock and are refused. ACE-Step 1.5 is a separate runtime: see
[ACESTEP15_CUDA.md](./ACESTEP15_CUDA.md).

The installer selects `scripts/requirements-acestep-cuda-windows.lock.txt` or
`scripts/requirements-acestep-cuda-linux.lock.txt` and runs
`uv pip sync --require-hashes --only-binary :all: --no-binary docopt --no-binary unidic-lite`
with `--preview-features build-dependency-hashes --require-build-hashes` and the
universal `requirements-acestep-mlx-build.lock.txt` as build constraints.
Every distribution, including torch and its transitive CUDA libraries, has an
exact version and SHA-256 hashes; Repair removes packages outside the lock. The
flow is shared with the other CUDA runtimes (`require_cuda_lock_host` and
`sync_cuda_lock_venv` in `scripts/setup-image-video.sh`).

Two caveats follow from upstream packaging:

- `docopt` (via `num2words`) and `unidic-lite` (via `fugashi[unidic-lite]`)
  publish only source distributions, so exactly those two may build from their
  hash-verified sdists. Both are pure Python. Their isolated build dependencies
  must also match the complete universal build lock, shared with Apple Silicon
  despite its historical `mlx` filename. Missing or mismatched build hashes
  fail installation; no unpinned backend can resolve.
- The `acestep` package is a git-only project. As on Apple Silicon, the
  installer clones `ace-step/ACE-Step`, checks out `ACESTEP_PIN`, and installs the
  checkout with `uv pip install --no-deps --no-build-isolation` after the sync
  (the lock carries the `setuptools` and `wheel` that build needs). A git SHA
  cannot satisfy `--require-hashes`, so the package itself is pinned by commit.

Direct pins are in `scripts/requirements-acestep-cuda.txt`: the Apple Silicon
dependency set with torch 2.14.1+cu126 (the build the other cu126 runtimes
share). torchvision 0.29.2 and torchaudio 2.11.1 are the PyPI wheels that pair
with that torch (no matching `+cu126` builds exist). A different
`PORTOS_TORCH_CUDA_INDEX` is rejected; changing CUDA requires regenerating and
validating both locks. Checkpoints download to `~/.cache/ace-step` on first
generation, never during install.

## Regenerating locks

Edit `scripts/requirements-acestep-cuda.txt` with exact direct pins. Use
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

lines = pathlib.Path("scripts/requirements-acestep-cuda.txt").read_text().splitlines()
deps = [line for line in lines if line and not line.startswith("#")]
pathlib.Path(sys.argv[1]).write_text(
    '[project]\nname="portos-acestep-cuda"\nversion="0.0.0"\n'
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
  out="scripts/requirements-acestep-cuda-${target}.lock.txt"
  cp "$out" "$TMP/$target.lock" # retain unrelated pins during resolution
  "$UV" --no-config pip compile "$TMP/pyproject.toml" \
    --upgrade-package filelock==4.2.9 --upgrade-package typing-inspection==0.4.5 \
    --python-version 3.11 --python-platform "$platform" \
    --generate-hashes --only-binary :all: --no-binary docopt --no-binary unidic-lite \
    --preview-features build-dependency-hashes --require-build-hashes \
    --build-constraints "$PWD/scripts/requirements-acestep-mlx-build.lock.txt" \
    --no-header --no-annotate \
    --index-url https://pypi.org/simple --emit-index-url \
    --exclude-newer "$CUTOFF" -o "$TMP/$target.lock"
  {
    printf '# ACE-Step CUDA: CPython 3.11, x86_64 %s, CUDA 12.6.\n' "$target"
    printf '# uv 0.13.7; exclude-newer %s; regenerate: docs/ACESTEP_CUDA.md.\n' "$CUTOFF"
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
`requirements-acestep-cuda-{target}.lock.txt` as the lock path. Any advisory or
unreadable response blocks the merge.

## Fresh install and readiness evidence

Needs an NVIDIA CUDA host for a meaningful probe. Use an isolated home:

```bash
export HOME="$PWD/.cache/acestep-validation-home"
export PORTOS_DATA="$HOME/data"
INSTALL_ACESTEP=1 INSTALL_MFLUX=0 INSTALL_VIDEO=0 INSTALL_FLUX2=0 \
  bash scripts/setup-image-video.sh
# Repeat to exercise Repair.
"$HOME/.portos/venv-acestep/bin/python3" -c "import torch; print(torch.__version__, torch.version.cuda, torch.cuda.is_available())"
```

(`Scripts/python.exe` on Windows.) The installer's own probe imports
`ACEStepPipeline`. Record OS, GPU, driver/CUDA, Python/torch versions, the
selected lock and redacted probe output; run `uv pip check --python` with the
venv interpreter and confirm Repair leaves versions unchanged. A Windows probe
does not certify Linux. Import evidence does not claim generation quality.
