#!/usr/bin/env bash
# Run in the pinned Pixal3D-mac checkout. Model downloads are owned by Generate.
set -euo pipefail

SCRIPTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REVISION=0be9e69a729432323dfb60a418801e5e9e7a1437
[[ "$(uname -s)" == Darwin && "$(uname -m)" == arm64 ]] || { echo 'Pixal3D Metal requires Apple Silicon macOS.' >&2; exit 1; }
[[ "$(git rev-parse HEAD)" == "$REVISION" ]] || { echo 'Unexpected Pixal3D source revision.' >&2; exit 1; }
# Finding the stub is insufficient when Xcode's downloadable component is absent.
xcrun -sdk macosx metal --version

PY="${PYTHON_BIN:-}"
if [[ -z "$PY" ]]; then
  for cand in /opt/homebrew/opt/python@3.13/bin/python3.13 "$(command -v python3.13 2>/dev/null || true)"; do
    if [[ -n "$cand" && -x "$cand" ]]; then PY="$cand"; break; fi
  done
else
  PY="$(command -v "$PY" 2>/dev/null || true)"
fi
[[ -n "$PY" && -x "$PY" ]] || { echo 'Install python@3.13 or set PYTHON_BIN to Python 3.13.' >&2; exit 1; }
"$PY" -c 'import sys; assert sys.version_info[:2] == (3, 13), "Pixal3D requires Python 3.13"'

# A repaired 3.10 venv can retain incompatible native modules and unlocked extras.
# Only this private interpreter is rebuilt; source and model assets are retained.
[[ ! -L .venv ]] || { echo 'Refusing to rebuild a symlinked Pixal3D environment.' >&2; exit 1; }
"$PY" -m venv --clear .venv
VPY=.venv/bin/python
"$VPY" -m pip install --disable-pip-version-check --require-hashes --no-deps --only-binary :all: -r "$SCRIPTS_DIR/requirements-pixal3d-mps.lock.txt"
"$VPY" -m pip install --disable-pip-version-check --require-hashes --no-deps --no-build-isolation -r "$SCRIPTS_DIR/requirements-pixal3d-mps-sources.lock.txt"

# Archive Git objects, not the working directory: builds and renders use the
# same pinned source, even if an earlier checkout has local changes/artifacts.
PORTOS_SOURCE=.venv/portos-source
mkdir -p "$PORTOS_SOURCE"
git archive --format=tar "$REVISION" | tar -xf - -C "$PORTOS_SOURCE"

# Torch 2.15 headers require C++20. Patch only the private build sources.
"$VPY" - "$PORTOS_SOURCE" <<'PY'
from pathlib import Path
import sys
for package in ('mtlmesh', 'mtlgemm', 'mtlbvh', 'mtldiffrast', 'o_voxel'):
    setup = Path(sys.argv[1]) / 'extern' / package / 'setup.py'
    source = setup.read_text()
    assert '-std=c++17' in source, f'Unexpected build flags in {package}'
    setup.write_text(source.replace('-std=c++17', '-std=c++20'))
PY

for package in mtlmesh mtlgemm mtlbvh mtldiffrast o_voxel natten-mps; do
  "$VPY" -m pip install --disable-pip-version-check --no-deps --no-build-isolation --no-cache-dir -e "$PORTOS_SOURCE/extern/$package"
done

"$VPY" - <<'PY'
import torch, torchvision, moge, cumesh, flex_gemm, mtlbvh, mtldiffrast, o_voxel, natten, natten_mps
assert torch.__version__.split('+')[0] == '2.15.0'
assert torchvision.__version__.split('+')[0] == '0.29.2'
assert torch.backends.mps.is_available(), 'MPS backend unavailable'
print('[setup] Torch 2.15.0, torchvision 0.29.2, MPS and native imports OK')
PY
