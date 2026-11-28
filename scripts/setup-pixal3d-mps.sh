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
WHEEL_LOCK="$SCRIPTS_DIR/ml/requirements/requirements-pixal3d-mps.lock.txt"
SOURCE_LOCK="$SCRIPTS_DIR/ml/requirements/requirements-pixal3d-mps-sources.lock.txt"
"$VPY" -m pip install --disable-pip-version-check --require-hashes --no-deps --only-binary :all: -r "$WHEEL_LOCK"

# MoGe's published metadata still requires Gradio and a second OpenCV distribution.
# Split it out of the hashed source lock, unpack the verified archive, and patch
# before install so `pip check` sees the CLI lane rather than the web demo.
FILTERED=".venv/sources-without-moge.txt"
MOGE_REQ=".venv/moge-requirement.txt"
"$VPY" - "$SOURCE_LOCK" "$FILTERED" "$MOGE_REQ" <<'PY'
from pathlib import Path
import sys
blocks, current = [], []
for line in Path(sys.argv[1]).read_text().splitlines(True):
    if line.startswith('#') or not line.strip():
        continue
    if current and not line[:1].isspace():
        blocks.append(''.join(current))
        current = []
    current.append(line)
if current:
    blocks.append(''.join(current))
moge = [block for block in blocks if block.startswith('moge ')]
rest = [block for block in blocks if not block.startswith('moge ')]
if len(moge) != 1:
    raise SystemExit('Expected exactly one hashed MoGe source requirement')
Path(sys.argv[2]).write_text(''.join(rest))
Path(sys.argv[3]).write_text(moge[0])
PY
"$VPY" -m pip install --disable-pip-version-check --require-hashes --no-deps --no-build-isolation -r "$FILTERED"
MOGE_DOWNLOAD=".venv/moge-download"
MOGE_STAGE=".venv/moge-src"
rm -rf "$MOGE_DOWNLOAD" "$MOGE_STAGE"
mkdir -p "$MOGE_DOWNLOAD" "$MOGE_STAGE"
"$VPY" -m pip download --disable-pip-version-check --require-hashes --no-deps --no-build-isolation -r "$MOGE_REQ" -d "$MOGE_DOWNLOAD"
"$VPY" - "$MOGE_DOWNLOAD" "$MOGE_STAGE" "$SCRIPTS_DIR/ml/patch-moge-metadata.py" <<'PY'
import sys
import tarfile
from pathlib import Path
download, stage, patcher = (Path(arg) for arg in sys.argv[1:])
# pip can save a codeload archive under its bare commit ID.
archives = list(download.iterdir())
if len(archives) != 1 or archives[0].is_symlink() or not archives[0].is_file():
    raise SystemExit('Expected one hash-verified MoGe archive')
if not hasattr(tarfile, 'data_filter'):
    raise SystemExit('Update the bootstrap Python to a security-patched build with tarfile.data_filter.')
with tarfile.open(archives[0]) as source:
    source.extractall(stage, filter='data')
roots = [path for path in stage.iterdir() if path.is_dir()]
if len(roots) != 1 or not (roots[0] / 'pyproject.toml').is_file():
    raise SystemExit('Expected one MoGe source root')
destination = stage / 'pkg'
roots[0].rename(destination)
sys.argv = [str(patcher), str(destination)]
import runpy
runpy.run_path(str(patcher), run_name='__main__')
PY
"$VPY" -m pip install --disable-pip-version-check --no-deps --no-build-isolation --no-cache-dir "$MOGE_STAGE/pkg"

# Archive Git objects, not the working directory: builds and renders use the
# same pinned source, even if an earlier checkout has local changes/artifacts.
PORTOS_SOURCE=.venv/portos-source
mkdir -p "$PORTOS_SOURCE"
git archive --format=tar "$REVISION" | tar -xf - -C "$PORTOS_SOURCE"

# Match the render environment. Keep tuning outside the venv rebuilt by Repair.
export FLEX_GEMM_AUTOTUNE_CACHE_PATH="$(pwd -P)/autotune_cache.json"

# Patch only the private build sources. Torch 2.15 headers require C++20.
"$VPY" - "$PORTOS_SOURCE" <<'PY'
from pathlib import Path
import sys

for package in ('mtlmesh', 'mtlgemm', 'mtlbvh', 'mtldiffrast', 'o_voxel'):
    setup = Path(sys.argv[1]) / 'extern' / package / 'setup.py'
    source = setup.read_text()
    assert '-std=c++17' in source, f'Unexpected build flags in {package}'
    source = source.replace('-std=c++17', '-std=c++20')
    if package == 'mtlgemm':
        # Both build branches run their cache hook during packaging. Seed only
        # from bundled data and use exclusive creation to preserve measured tuning.
        for quote in ('"', "'"):
            upstream = f'''    os.makedirs(os.path.expanduser("~/.flex_gemm"), exist_ok=True)
    cache_src = os.path.join(ROOT, "autotune_cache.json")
    if os.path.exists(cache_src):
        shutil.copyfile(cache_src, os.path.expanduser({quote}~/.flex_gemm/autotune_cache.json{quote}))'''
            if source.count(upstream) != 1:
                raise SystemExit('Unexpected FlexGEMM autotune cache hook')
            source = source.replace(upstream, '''    cache_src = os.path.join(ROOT, "autotune_cache.json")
    if os.path.exists(cache_src):
        try:
            with open(cache_src, "rb") as bundled, open(os.environ["FLEX_GEMM_AUTOTUNE_CACHE_PATH"], "xb") as local:
                shutil.copyfileobj(bundled, local)
        except FileExistsError:
            pass''')
    setup.write_text(source)
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
"$VPY" -m pip check
