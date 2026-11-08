# LTX-2.5 CUDA runtime

Video Gen's explicit Install/Repair installs this runtime in
`~/.portos/ltx-2.5-cuda/.venv`. It supports CPython 3.11 on x86_64 Windows
(Git Bash) and Linux (glibc 2.28+), with an NVIDIA driver supporting CUDA 12.6.
[uv](https://docs.astral.sh/uv/) provisions a dedicated managed interpreter;
other Python minors and Conda-based environments are rebuilt during Repair.
Model weights remain a separate explicit Video Gen download.

Install/Repair selects `scripts/requirements-ltx25-cuda-windows.lock.txt` or
`scripts/requirements-ltx25-cuda-linux.lock.txt`. Every distribution, including
transitives and the build backend, has an exact version/source revision and
SHA-256 hashes. Repair syncs the complete set, removing extra packages. The
runtime currency probe checks every version and the LTX archive provenance, so
an older importable environment still offers Upgrade/Repair.

The stack uses torch 2.14.1+cu126, torchvision 0.29.1+cu126 and torchaudio
2.11.1. Torchaudio 2.11.1 declares torch>=2.11 instead of requiring the same
minor version; its PyPI wheel supplies the audio operations used by LTX.
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

Edit exact direct pins in `scripts/requirements-ltx25-cuda.txt`, then use uv
0.10.6 from the repository root (Bash):

```bash
for target in windows linux; do
  case "$target" in
    windows) platform=x86_64-pc-windows-msvc ;;
    linux) platform=x86_64-manylinux_2_28 ;;
  esac
  uv pip compile scripts/requirements-ltx25-cuda.txt \
    --python-version 3.11 --python-platform "$platform" \
    --generate-hashes --only-binary :all: \
    --index-url https://pypi.org/simple \
    --extra-index-url https://download.pytorch.org/whl/cu126 \
    --index-strategy unsafe-best-match --emit-index-url \
    --no-header --annotation-style line \
    -o "scripts/requirements-ltx25-cuda-${target}.lock.txt"
done
python3 - <<'PY'
import re
from pathlib import Path
lock = Path('scripts/requirements-ltx25-cuda-windows.lock.txt').read_text()
backend = re.search(r'^uv-build==[^\n]+\n(?:[ \t]+[^\n]*\n?)*', lock, re.M)
assert backend, 'missing build backend'
Path('scripts/requirements-ltx25-cuda-build.lock.txt').write_text(
    '# Build backend for the two immutable LTX source archives.\n'
    '# Bootstrap with --require-hashes before the --no-build-isolation runtime sync.\n'
    + backend[0])
PY
```

Keep each lock's target header. Existing output pins preserve the previous
transitive set; use `--upgrade` deliberately when refreshing that set. The
multi-index strategy permits PyPI packages alongside CUDA wheels; installation
still requires the committed hashes. Verify publication dates using PyPI's
release metadata when reviewing updates: some upstream simple-index entries
omit timestamps, so uv's exclude-newer cannot resolve this set reliably.
The source manifests/build backend must be inspected before running compile,
which may prepare source metadata.

Query OSV for every exact resolved package, including `MAL-` records,
immediately before merge. This includes the two source package versions and
uv-build; normalize CUDA local tags to upstream versions:

```bash
python3 - <<'PY'
import json, re, urllib.request
from pathlib import Path
for target in ('windows', 'linux'):
    text = Path(f'scripts/requirements-ltx25-cuda-{target}.lock.txt').read_text()
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
Also run the installed Python with `scripts/ltx25_cuda_currency.py` and the
selected lock; exit 0 means current, 78 means Upgrade/Repair is needed.

Record OS, GPU model, driver/CUDA version, Python version, selected lock and
redacted probe output in the PR. A WSL2 environment may use the same physical
GPU as Windows, but each environment must install its own lock. Untested
targets keep their hardware evidence requirement unresolved. Do not download
model weights or trigger generation during these checks; readiness does not
establish render quality, speed or the separately documented memory floor.
