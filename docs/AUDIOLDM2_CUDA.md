# AudioLDM2 Windows/Linux runtime

The explicit AudioLDM2 Install/Repair action (`INSTALL_AUDIOLDM2=1`) installs
the runtime in `~/.portos/venv-audioldm2`. Apple Silicon uses its own lock
(`scripts/requirements-audioldm2-mlx.lock.txt`). Windows (Git Bash) and Linux
are supported on x86_64 and need [uv](https://docs.astral.sh/uv/), which
provisions a dedicated managed CPython 3.11. Repair reuses standalone 3.11
environments and rebuilds other Python minors or Conda-based environments,
which can fail to load torch DLLs on Windows. Intel macOS and non-x86_64
Windows/Linux hosts have no lock and are refused.

The installer selects `scripts/requirements-audioldm2-cuda-windows.lock.txt`
or `scripts/requirements-audioldm2-cuda-linux.lock.txt` and runs
`uv pip sync --require-hashes --only-binary :all:` against the runtime
interpreter. Every distribution, including torch and its transitive CUDA
libraries, has an exact version and SHA-256 hashes. Repair removes packages
outside the lock. No pip/bootstrap upgrades run on this path.

The stack uses torch 2.14.1+cu126 (the build the other cu126 runtimes share),
diffusers 0.42.1, transformers 5.22.1, huggingface-hub 2.4.0 with hf-xet,
sentencepiece 0.2.3, accelerate 1.15.0, numpy 2.4.6 and scipy 1.17.1, matching
the Apple Silicon lock's direct pins. The CUDA torch build also runs on a host
without an NVIDIA GPU, so AudioLDM2 keeps its CPU fallback; the readiness probe
imports the pipeline and does not require a CUDA device. A different
`PORTOS_TORCH_CUDA_INDEX` is rejected for this runtime: changing CUDA requires
regenerating and validating both locks.

Model weights remain a separate explicit download. Installing and repairing
never download weights or generate audio.

## Regenerating locks

Edit `scripts/requirements-audioldm2-cuda.txt` with exact direct pins. Use
hash-verified uv 0.13.7 and the [scoped-index recipe](./WAN22_CUDA.md#regenerating-locks),
substituting the AudioLDM2 source/output names and scoping only Torch to the
CUDA index (AudioLDM2 has no Torchvision dependency). Keep CPython 3.11 and
both x86_64 target platforms. Preserve the existing output pins, markers and
unrelated hash blocks; advance the cutoff to at least seven days ago.

Do not resolve ordinary PyPI packages from the CUDA mirror: some entries have
no upload date and fail cooldown validation. The
[bounded #15988 procedure](./PYTHON_RUNTIME_REFRESH.md#newly-cooled-follow-on-2026-11-13-15988)
describes complete-closure constraints and selective generated-block transfer.
Installation retains its existing indexes and exact hash restrictions.

Query OSV for **every resolved package**, including `MAL-` records, immediately
before merge. This standard-library Python check normalizes CUDA local build
tags to the upstream version and fails on any advisory or unreadable response:

```bash
python3 - <<'PY'
import json
import re
import urllib.request
from pathlib import Path

for target in ("windows", "linux"):
    lock = Path(f"scripts/requirements-audioldm2-cuda-{target}.lock.txt")
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

## Fresh install and readiness evidence

Use an isolated home/data directory to exercise the actual installer without
replacing a working runtime. From Bash, with no other runtime install flags set:

```bash
export HOME="$PWD/.cache/audioldm2-validation-home"
export PORTOS_DATA="$HOME/data"
INSTALL_AUDIOLDM2=1 INSTALL_MFLUX=0 INSTALL_VIDEO=0 INSTALL_FLUX2=0 \
  bash scripts/setup-image-video.sh
# Repeat the same command to exercise Repair.
```

The installer's probe imports torch and `AudioLDM2Pipeline`. On an NVIDIA host,
also run:

```bash
"$HOME/.portos/venv-audioldm2/bin/python3" -c "import torch; print(torch.__version__, torch.version.cuda, torch.cuda.is_available())"
```

(`Scripts/python.exe` on Windows) and expect `True`. Record OS, GPU model,
driver/driver-supported CUDA, Python/torch/bundled CUDA versions, selected lock
and redacted probe output in the PR. Run `uv pip check --python` with the
installed interpreter and verify Repair leaves the lock's versions unchanged. A
Windows probe does not certify the Linux target; untested targets retain their
hardware evidence requirement. Import/readiness evidence does not claim render
quality or speed.
