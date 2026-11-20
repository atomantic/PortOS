# Runtime lock procedure (CUDA runtimes)

Shared procedure for regenerating, auditing and validating the hash-locked
Windows/Linux CUDA runtimes. Each runtime doc keeps only its own pins, index
scoping, extra resolver flags and probes, and links here for everything else:

| Runtime | Doc |
| --- | --- |
| ACE-Step v1 | [ACESTEP_CUDA.md](./ACESTEP_CUDA.md) |
| ACE-Step 1.5 | [ACESTEP15_CUDA.md](./ACESTEP15_CUDA.md) |
| AudioLDM2 | [AUDIOLDM2_CUDA.md](./AUDIOLDM2_CUDA.md) |
| FLUX.2 | [FLUX2_CUDA.md](./FLUX2_CUDA.md) |
| MiniMax H3 | [MINIMAX_H3_CUDA.md](./MINIMAX_H3_CUDA.md) |
| MiniMax Music 3 | [MINIMAX_MUSIC3_CUDA.md](./MINIMAX_MUSIC3_CUDA.md) |
| MuScriptor | [MUSCRIPTOR_CUDA.md](./MUSCRIPTOR_CUDA.md) |
| Wan 2.2 | [WAN22_CUDA.md](./WAN22_CUDA.md) |

LTX-2.5, Pixal3D and TRELLIS.2 resolve differently (immutable source archives,
Conda inventories) and document their own procedures. Apple Silicon locks and
held-back pins are in [PYTHON_RUNTIME_REFRESH.md](./PYTHON_RUNTIME_REFRESH.md).

## Regenerating locks

Edit the runtime's `scripts/ml/requirements/requirements-<slug>.txt` with exact direct pins.
Use hash-verified uv **0.13.7** (the `requirements-uv-bootstrap.lock.txt`
bootstrap), setting `UV` to that executable. The CUDA index is an explicit
named index scoped only to the runtime's CUDA-local packages (normally Torch)
during resolution: its mirrors of unrelated packages can lack publication
dates, which correctly makes a global multi-index resolve fail the cooldown.
Keep all other packages on PyPI rather than dropping the cooldown.

Keep CPython 3.11 and both x86_64 targets. Preserve the existing output pins,
markers and unrelated hash blocks (the script seeds resolution from the old
output; never remove it first), advance the cutoff to a UTC date at least seven
days old, and restore each target/cutoff header. The
[selective regeneration procedure](./PYTHON_RUNTIME_REFRESH.md#selective-regeneration)
describes complete-closure constraints and selective generated-block transfer.

Run from the repository root in Bash. Set the per-runtime values from the
runtime doc's own "Regenerating locks" section, then run the rest unchanged:

```bash
set -euo pipefail
: "${UV:?set UV to the verified uv 0.13.7 executable}"
SLUG=                 # scripts/ml/requirements/requirements-$SLUG.txt, e.g. wan22-cuda
LABEL=                # lock header label, e.g. "Wan 2.2 CUDA"
DOC=                  # runtime doc named in the lock header, e.g. docs/WAN22_CUDA.md
CUDA_SCOPED=          # packages routed to the CUDA index, e.g. "torch torchvision"
LINUX_CUDA_SCOPED=    # extra packages routed to the CUDA index on Linux only
COMPILE_EXTRA=()      # extra uv pip compile flags
CUTOFF=2026-11-05T00:00:00Z  # advance to a UTC date at least seven days old
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
for target in windows linux; do
  case "$target" in
    windows) platform=x86_64-pc-windows-msvc; scoped="$CUDA_SCOPED" ;;
    linux) platform=x86_64-manylinux_2_28; scoped="$CUDA_SCOPED $LINUX_CUDA_SCOPED" ;;
  esac
  python3 - "$TMP/pyproject.toml" "$SLUG" "$scoped" <<'PYPROJECT'
import json
import pathlib
import sys

out, slug, scoped = sys.argv[1], sys.argv[2], sys.argv[3].split()
lines = pathlib.Path(f"scripts/ml/requirements/requirements-{slug}.txt").read_text().splitlines()
deps = [line for line in lines if line and not line.startswith("#")]
sources = "".join(f'{name}={{index="pytorch"}}\n' for name in scoped)
pathlib.Path(out).write_text(
    f'[project]\nname="portos-{slug}"\nversion="0.0.0"\n'
    'requires-python=">=3.11"\ndependencies=' + json.dumps(deps) + '\n'
    '[tool.uv.sources]\n' + sources +
    '[[tool.uv.index]]\nname="pytorch"\n'
    'url="https://download.pytorch.org/whl/cu126"\nexplicit=true\n'
)
PYPROJECT
  out="scripts/ml/requirements/requirements-${SLUG}-${target}.lock.txt"
  cp "$out" "$TMP/$target.lock" # retain unrelated pins during resolution
  "$UV" --no-config pip compile "$TMP/pyproject.toml" \
    --python-version 3.11 --python-platform "$platform" \
    --generate-hashes --only-binary :all: --no-header --no-annotate \
    --index-url https://pypi.org/simple --emit-index-url \
    ${COMPILE_EXTRA[@]+"${COMPILE_EXTRA[@]}"} \
    --exclude-newer "$CUTOFF" -o "$TMP/$target.lock"
  {
    printf '# %s: CPython 3.11, x86_64 %s, CUDA 12.6.\n' "$LABEL" "$target"
    printf '# uv 0.13.7; exclude-newer %s; regenerate: %s.\n' "$CUTOFF" "$DOC"
    # pip-format locks cannot encode uv's named explicit index. Installation
    # retains the CUDA index, but versions and allowed artifact hashes are fixed.
    printf '%s\n' '--extra-index-url https://download.pytorch.org/whl/cu126'
    cat "$TMP/$target.lock"
  } > "$out"
done
```

The temporary project derives its pins from the source requirements rather than
maintaining a second dependency list. `--no-annotate` keeps temporary
filesystem paths out of the committed locks. The pip-format lock retains the
installation index, but every accepted artifact stays constrained by its
SHA-256 hash. Verify the CUDA-scoped packages' official simple-index entries
(SHA-256 values and upload timestamps) against the lock and cutoff. The
preserved Triton entry also contains official PyTorch build hashes; verify
those against the CUDA index's `triton/` entries and their upload timestamps.
They are part of the unchanged native baseline, not new artifacts introduced
by a refresh. Verify all remaining artifacts against PyPI metadata. Never drop
the cutoff or hand-edit generated hashes.

This changes regeneration only. Install/Repair retains its existing index
strategy with complete `--require-hashes` locks; that does not permit packages
or artifacts outside the committed set.

### OSV audit

Query OSV for **every resolved package**, including `MAL-` records,
immediately before merge. This standard-library Python check normalizes CUDA
local build tags to the upstream version and fails on any advisory or
unreadable response. Pass the runtime slug (the `SLUG` above, for example
`wan22-cuda`):

```bash
python3 - wan22-cuda <<'PY'
import json
import re
import sys
import urllib.request
from pathlib import Path

for target in ("windows", "linux"):
    lock = Path(f"scripts/ml/requirements/requirements-{sys.argv[1]}-{target}.lock.txt")
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

Check response counts, errors and pagination; any advisory or unreadable
response blocks the merge.

## Fresh install and readiness evidence

Use an isolated home and `PORTOS_DATA` directory to exercise the actual
installer without replacing a working runtime. From Bash (Git Bash on Windows),
run the runtime's install command with every other runtime flag set to `0`
(each runtime doc lists its exact command), then run it again to exercise
Repair. Do not download model weights or generate media for this check.

On an NVIDIA host, run the runtime's CUDA probe with the isolated venv's
interpreter (`Scripts/python.exe` on Windows) and expect
`torch.cuda.is_available()` to be `True`.

Record in the PR: OS, GPU model, driver and driver-supported CUDA,
Python/torch/bundled CUDA versions, the selected lock, and redacted probe
output. Run `uv pip check --python` with the installed interpreter and verify
Repair leaves the lock's versions unchanged.

Evidence limits: a Windows probe does not certify the Linux target (Linux/WSL
may share a GPU with Windows but each environment installs from its own lock),
and untested targets retain their hardware evidence requirement and stay
pending. Hashes, resolution and import/readiness probes establish dependency
compatibility only; they do not claim render, generation, transcription
quality or speed.
