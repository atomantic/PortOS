# LTX-2.5 CUDA runtime

Video Gen's explicit Install/Repair installs this runtime in
`~/.portos/ltx-2.5-cuda/.venv`. It supports CPython 3.11 on x86_64 Windows
(Git Bash) and Linux (glibc 2.28+), with an NVIDIA driver supporting CUDA 13.2.
[uv](https://docs.astral.sh/uv/) provisions a dedicated managed interpreter;
other Python minors and Conda-based environments are rebuilt during Repair.
Model weights remain a separate explicit Video Gen download.

Install/Repair selects `scripts/ml/requirements/requirements-ltx25-cuda-windows.lock.txt` or
`scripts/ml/requirements/requirements-ltx25-cuda-linux.lock.txt`. Every distribution, including
transitives and the build backend, has an exact version/source revision and
SHA-256 hashes. Repair syncs the complete set, removing extra packages. The
runtime currency probe checks every version and the LTX archive provenance, so
an older importable environment still offers Upgrade/Repair.

The stack uses torch 2.14.1+cu132, torchvision 0.29.1+cu132 and torchaudio
2.11.1+cu132. Torchaudio 2.11.1 declares torch>=2.11 instead of requiring the same
minor version. All three native packages use the same CUDA 13.2 index.
This preserves Blackwell support; CUDA 12.6 wheels omit its SM120 kernels.
PyPI's Linux torchaudio wheel requires CUDA 13, so selecting the explicit CUDA
build also avoids mixing that native extension with an older torch runtime.
The previous torch 2.10.0 pin matches OSV GHSA-rrmf-rvhw-rf47 and
PYSEC-2026-139. The new stack removes those advisories. Transformers stays at
5.14.1 because the pinned LTX package explicitly requires <5.15 for its Gemma
encoder. A different `PORTOS_LTX25_CUDA_TORCH_INDEX` is refused; changing CUDA
requires regenerating and validating both locks together.

## Immutable LTX packaging

PyPI currently supplies LTX 1.0.0; this runtime needs the official 1.2.0 source.
Both locks reference the GitHub archive at commit
`d151147788a9284cca791edc6ce898007e727fe6`, with separate package subdirectories.
The archive SHA-256 is
`ff8302cdc47b10f09e14a910c0d94e32e0ef1601573d2d8827d715eb1f31e00f`.
No git operation, moving tag, editable install or vendored wheel is used.

The two pure-Python packages declare only `uv_build>=0.9.8,<0.10.0` as their
build requirement. The installer first installs uv-build 0.9.30 with
`--require-hashes --only-binary :all: --no-deps` from the separate build lock.
It then runs `uv pip sync --require-hashes --no-build-isolation`, allowing
source builds only for `ltx-core,ltx-pipelines`; every other dependency must be
a wheel. This prevents isolated builds from resolving unpinned tooling. The
backend also belongs to both complete runtime locks. A source update requires
reviewing both package manifests and updating the currency probe's package
version along with the source hashes.

## Regenerating locks

Edit exact direct pins in `scripts/ml/requirements/requirements-ltx25-cuda.txt`.
Use hash-verified uv **0.13.7** from
`scripts/ml/requirements/requirements-uv-bootstrap.lock.txt` (install with
`--require-hashes --no-deps --only-binary :all:` in an isolated tool venv).
Set `UV` to that executable's absolute path. Inspect both LTX source package
manifests and the locked build backend before compiling, as uv may prepare source
metadata. Run from the repository root in Bash:

```bash
set -euo pipefail
: "${UV:?set UV to the verified uv 0.13.7 executable}"
[[ $("$UV" --no-config --version) == 'uv 0.13.7' ]]
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
for target in windows linux; do
  case "$target" in
    windows) platform=x86_64-pc-windows-msvc ;;
    linux) platform=x86_64-manylinux_2_28 ;;
  esac
  out="scripts/ml/requirements/requirements-ltx25-cuda-${target}.lock.txt"
  cp "$out" "$tmp/$target.lock.txt"
  "$UV" --no-config pip compile scripts/ml/requirements/requirements-ltx25-cuda.txt \
    --python-version 3.11 --python-platform "$platform" \
    --generate-hashes --only-binary :all: \
    --index-url https://pypi.org/simple \
    --extra-index-url https://download.pytorch.org/whl/cu132 \
    --index-strategy unsafe-best-match --emit-index-url \
    --no-header --annotation-style line \
    -o "$tmp/$target.lock.txt"
  {
    head -n 3 "$out"
    cat "$tmp/$target.lock.txt"
  } > "$tmp/$target.with-header"
done
for target in windows linux; do
  cp "$tmp/$target.with-header" "scripts/ml/requirements/requirements-ltx25-cuda-${target}.lock.txt"
done
python3 - <<'PY'
import re
from pathlib import Path
lock = Path('scripts/ml/requirements/requirements-ltx25-cuda-windows.lock.txt').read_text()
backend = re.search(r'^uv-build==[^\n]+\n(?:[ \t]+[^\n]*\n?)*', lock, re.M)
assert backend, 'missing build backend'
Path('scripts/ml/requirements/requirements-ltx25-cuda-build.lock.txt').write_text(
    '# Build backend for the two immutable LTX source archives.\n'
    '# Bootstrap with --require-hashes before the --no-build-isolation runtime sync.\n'
    + backend[0])
PY
```

The three header lines preserve the target, LTX version and source revision,
and regeneration guide. If the immutable source changes, update the second
line in both locks to match the reviewed archive. Seeding the scratch output
preserves existing transitive pins; use `--upgrade` deliberately to refresh them.

Choose a UTC cutoff at least three days old and record it in the refresh PR.
Some entries in this runtime's multi-index resolve lack timestamps, so verify
the cooldown against authoritative metadata before committing the locks. Check
every allowed wheel hash and upload date against PyPI or the official CUDA 13.2
index, and verify the immutable LTX archive hash and source release date against
upstream. Require matching hashes, non-yanked registry artifacts and dates at
or before the cutoff. Hold the refresh if any of that evidence is missing.
See [Runtime locks](./RUNTIME_LOCKS.md#regenerating-locks) and
[Python runtime refresh](./PYTHON_RUNTIME_REFRESH.md#selective-regeneration).

Query OSV for every exact resolved package, including `MAL-` records,
immediately before merge. This includes the two source package versions and
uv-build; normalize CUDA local tags to upstream versions:

```bash
python3 - <<'PY'
import json, re, urllib.request
from pathlib import Path
for target in ('windows', 'linux'):
    text = Path(f'scripts/ml/requirements/requirements-ltx25-cuda-{target}.lock.txt').read_text()
    pins = re.findall(r'^([\w.-]+)==([^\s\\;]+)', text, re.M)
    assert pins and len(re.findall(r'^ltx-(?:core|pipelines) @ ', text, re.M)) == 2
    pins += [('ltx-core', '1.2.0'), ('ltx-pipelines', '1.2.0')]
    queries = [{'package': {'name': name, 'ecosystem': 'PyPI'},
                'version': version.split('+')[0]} for name, version in pins]
    request = urllib.request.Request('https://api.osv.dev/v1/querybatch',
        json.dumps({'queries': queries}).encode(), {'Content-Type': 'application/json'})
    with urllib.request.urlopen(request, timeout=60) as response:
        results = json.load(response)['results']
    assert len(results) == len(pins), 'incomplete OSV response'
    findings = [(pins[i], v['id']) for i, item in enumerate(results)
                for v in item.get('vulns', [])]
    print(target, len(pins), 'packages', findings)
    assert not findings, 'resolve all advisories before merge'
PY
```

## Readiness evidence

For a fresh validation, set HOME and PORTOS_DATA to isolated empty directories,
set `INSTALL_LTX25_CUDA=1 INSTALL_MFLUX=0 INSTALL_VIDEO=0 INSTALL_FLUX2=0`, and
run `bash scripts/setup-image-video.sh`. The final probe imports `torch`,
`ltx_core`, `ltx_pipelines` and `DistilledPipeline`, then asserts
`torch.cuda.is_available()`. Repeat Repair and compare `uv pip freeze` results.
Also run the installed Python with `scripts/ml/ltx25_cuda_currency.py` and the
selected lock; exit 0 means current, 78 means Upgrade/Repair is needed.

Record OS, GPU model, driver/CUDA version, Python version, selected lock and
redacted probe output in the PR. A WSL2 environment may use the same physical
GPU as Windows, but each environment must install its own lock. Untested
targets keep their hardware evidence requirement unresolved. Do not download
model weights or trigger generation during these checks; readiness does not
establish render quality, speed or the separately documented memory floor.
