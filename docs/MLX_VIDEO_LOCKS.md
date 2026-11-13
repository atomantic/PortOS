# MLX video runtime locks

Video Gen Install and Repair use PortOS-owned, hash-pinned inference locks for
Apple Silicon CPython 3.11. Each lock binds to a clean checkout at its audited
source revision. An install with the right source revision and older packages
appears as needing an upgrade.

| Runtime | Upstream revision | SHA-256 of upstream `uv.lock` | Inference lock |
| --- | --- | --- | --- |
| LTX-2.3 MLX | [dgrauet/ltx-2-mlx at 1192051](https://github.com/dgrauet/ltx-2-mlx/blob/1192051fd380e0501adb5f3c0e9a216e679cb123/uv.lock) | `0dd7510a74a99f13b621b4d4a42ad2b0a07b05f4fe98544313e308c189d3eb54` | [LTX-2.3 lock](../scripts/requirements-ltx23-mlx.lock.txt) |
| LTX-2.5 MLX | [MrMoferFRAN/ltx-2-mlx at 5795228](https://github.com/MrMoferFRAN/ltx-2-mlx/blob/57952288076766abe27dda3a774b2c24f7346977/uv.lock) | `d5e10ec955678f72c950b1af5f297d02161fb3f59b38f84493fc06284c5cb1d8` | [LTX-2.5 lock](../scripts/requirements-ltx25-mlx.lock.txt) |
| Wan 2.2 MLX | [lpalbou/mlx-gen at 2452f0c](https://github.com/lpalbou/mlx-gen/blob/2452f0c12edcc8886eebf15772205ce9c417a618/uv.lock) | `437647576a6673afb4f94512d8ce59cd504fc203cafe1de613b78006cd2f3033` | [Wan 2.2 lock](../scripts/requirements-wan22-mlx.lock.txt) |
| FastVideo MLX | [hao-ai-lab/FastVideo at fa2d132](https://github.com/hao-ai-lab/FastVideo/tree/fa2d1324c60050cd65209c6aaeac470e7fb412f5) | N/A (pyproject-locked) | [FastVideo lock](../scripts/requirements-fastvideo-mlx.lock.txt) |

The installer first syncs registry wheels with `--require-hashes --only-binary
:all:`. It then builds the two editable LTX inference packages or the MLX-Gen
wheel. The isolated builds use
`--no-deps --require-build-hashes` and the separate
[`requirements-mlx-video-build.lock.txt`](../scripts/requirements-mlx-video-build.lock.txt).
This keeps the build dependencies out of the inference environment. FastVideo MLX
locks its build backend (`setuptools>=61.0` and `wheel`) directly in the runtime lock
and installs its editable checkout with `--no-deps --no-build-isolation`, preventing
unconstrained build-time resolution. Hatchling
1.32+ rejects the workspace-relative README in the pinned LTX-2.3 sources.
Hatchling 1.31.0 and its editable-build dependency are locked for that reason.
MLX-Gen's build backend is `uv-build` 0.7.22, within its upstream declared range.
The build lock header documents regeneration with a seven-day release cutoff.
The Wan build stages the pinned Git source in a temporary directory and
replaces a private Pillow typing import with the equivalent stdlib annotation.
This keeps Pillow 13 usable on CPython 3.11 and preserves the upstream checkout.
LTX-2.3 retains MLX 0.31.1. Before changing it, check audio levels because the
0.31.2 release regressed audio peaks on that runtime. LTX-2.5 retains MLX
0.32.0 and the sampler source verified to preserve the frame-zero anchor.
Wan retains MLX 0.31.0 and AV 17.0.1.

## Audit on 2026-11-10

OSV querybatch covered every registry version in each universal lock, including
versions reachable only via other markers or optional groups. The native column
counts affected registry versions installed by the default Apple Silicon
CPython 3.11 inference profile.

| Runtime | Upstream lock | Upstream native inference | PortOS inference lock |
| --- | ---: | ---: | ---: |
| LTX-2.3 MLX | 12 / 58 | 8 / 36 | 0 / 36 |
| LTX-2.5 MLX | 12 / 58 | 8 / 36 | 0 / 36 |
| Wan 2.2 MLX | 15 / 112 | 10 / 45 | 0 / 51 |
| FastVideo MLX | N/A | N/A | 0 / 85 |

Each count is affected pins over registry pins. The upstream matches outside
LTX inference were GitPython, pytest, requests, and urllib3. Outside Wan
inference they were Accelerate, cryptography, Pygments, pytest, and setuptools.
The isolated build constraints had zero matches across seven pins. No MAL
records matched.

To repeat the inventory and OSV/MAL query, check out the corresponding revision
and pass its `uv.lock`, the PortOS build lock and its inference lock to the
following script. Verify the checkout and upstream lock digest against the
table first. The output includes every package/version and its advisory IDs.

```bash
python3.11 - /path/to/checkout/uv.lock scripts/requirements-mlx-video-build.lock.txt "$inference_lock" <<'PY'
import json
import re
import sys
import tomllib
from pathlib import Path
from urllib.request import Request, urlopen

upstream = tomllib.loads(Path(sys.argv[1]).read_text())
runtime = {
    (p["name"], p["version"]) for p in upstream["package"] if "registry" in p["source"]
}
portos = {
    pin for path in sys.argv[2:]
    for pin in re.findall(r"^([\w-]+)==(\S+)", Path(path).read_text(), re.M)
}
pins = sorted(runtime | portos)
query = {"queries": [
    {"package": {"name": name, "ecosystem": "PyPI"}, "version": version}
    for name, version in pins
]}
request = Request("https://api.osv.dev/v1/querybatch", json.dumps(query).encode(),
                  {"Content-Type": "application/json"})
with urlopen(request, timeout=30) as response:
    results = json.load(response)["results"]
for (name, version), result in zip(pins, results, strict=True):
    print(name, version, *(v["id"] for v in result.get("vulns", [])), sep="\t")
PY
```

To verify the upstream native subset, inspect the arm64 CPython 3.11
`uv sync --locked --dry-run` plan in a fresh environment. For the PortOS
profile, use the installer with the chosen runtime flag and compare
`uv pip list --format json --python <runtime-venv>/bin/python3` with the
inference lock. The installer runs `uv pip check` after building the source.

## Regenerating inference locks

Audit a candidate upstream revision and its inference subset first. If the
upstream lock still has affected pins, seed a scratch output file with
`uv export --locked --no-emit-workspace --no-dev --no-header -o "$lock"`.
Collect the `project.dependencies` arrays from the two LTX workspace packages
or the Wan root `pyproject.toml` into `$inputs`. Omit the LTX pipeline's
local `ltx-core-mlx` dependency.

```bash
MACOSX_DEPLOYMENT_TARGET=14.0 uv --no-config pip compile "$inputs" \
  --python-version 3.11 --python-platform aarch64-apple-darwin \
  --generate-hashes --only-binary :all: --no-header --no-annotate \
  --exclude-newer "$cutoff" -o "$lock" \
  -P anyio -P certifi -P filelock -P fsspec -P idna -P pillow \
  -P pygments -P transformers
```

The November 2026 refresh additionally used `-P requests -P torch -P urllib3`
for Wan. Set the UTC cutoff at least seven days in the past and choose the
packages to upgrade from the new audit. Review the updated native pins and
build constraints, query OSV for every output pin, and repeat fresh Install,
Repair and model smoke checks.

### Bounded shared-helper refresh (2026-11-12)

Keep the source revisions and upstream lock digests above unchanged. This refresh
uses verified **uv 0.13.7** and cutoff `2026-11-05T00:00:00Z`. Start from each
existing PortOS inference lock rather than reintroducing the upstream vulnerable
pins. Preserve all other profile pins with constraints, including the native
MLX/Metal, AV, Torch, model-library and Hub versions.

Set `runtime` to `ltx23`, `ltx25` or `wan22`, `source` to its verified checkout,
`lock` to its PortOS inference lock, and `inputs`/`constraints` to scratch files.
This derives the real upstream dependency inputs and freezes companion versions:

```bash
python3.11 - "$runtime" "$source" "$lock" "$inputs" "$constraints" <<'PY'
import re
import sys
import tomllib
from pathlib import Path

runtime, source, lock, inputs, constraints = sys.argv[1:]
source = Path(source)
projects = ([source / "pyproject.toml"] if runtime == "wan22" else [
    source / "packages" / package / "pyproject.toml"
    for package in ("ltx-core-mlx", "ltx-pipelines-mlx")
])
deps = [dependency for project in projects
        for dependency in tomllib.loads(project.read_text())["project"]["dependencies"]
        if dependency != "ltx-core-mlx"]
pins = dict(re.findall(r"^([\w.-]+)==([^\s\\]+)", Path(lock).read_text(), re.M))
pins.update({"anyio": "4.16.0", "markupsafe": "3.0.4",
             "regex": "2026.9.29", "typing-extensions": "4.16.0"})
if runtime != "wan22":
    pins.update({"click": "8.5.0", "typer": "0.27.3"})
    deps.append("click==8.5.0")  # Retain the existing explicit CLI companion.
Path(inputs).write_text("\n".join(deps) + "\n")
Path(constraints).write_text("\n".join(f"{name}=={version}"
                                     for name, version in sorted(pins.items())) + "\n")
PY
MACOSX_DEPLOYMENT_TARGET=14.0 uv --no-config pip compile "$inputs" \
  -c "$constraints" --python-version 3.11 \
  --python-platform aarch64-apple-darwin --generate-hashes \
  --only-binary :all: --no-header --no-annotate \
  --exclude-newer 2026-11-05T00:00:00Z -o "$lock"
```

Restore the three-line PortOS header with the new uv/cutoff. Review exact
package, marker and hash-set differences: only AnyIO, MarkupSafe, Regex and
Typing-Extensions change in Wan; LTX additionally changes Click and Typer.
AnyIO 4.16 requires Typing-Extensions 4.16 on Python below 3.15. Typer 0.27 no
longer requires the separate Click distribution; LTX deliberately retains its
existing explicit companion in this bounded update. All unchanged blocks must
remain byte-identical. Audit every resulting artifact and OSV/MAL response,
then repeat full hashed native installs and the actual helper-consumer checks
documented in [the runtime refresh record](PYTHON_RUNTIME_REFRESH.md).

### Coordinated LTX Hub transport refresh (2026-11-12)

This refresh applies only to LTX-2.3 and LTX-2.5, not Wan. The immutable
MLX-Gen source requires `huggingface-hub>=1.1.6,<2.0`; changing that source
contract is a separate migration. Both LTX sources permit Hub 2 with their
existing mlx-lm versions. Keep every source, MLX/Metal, model-library and build
pin unchanged.

Reuse the verified LTX project-input extraction and compile command above,
including the explicit Click input. Before writing the complete companion
constraints, replace the bounded helper-update block with:

```python
for name in ("httpx", "httpcore", "certifi"):
    pins.pop(name, None)
pins.update({"huggingface-hub": "2.4.0", "transformers": "5.22.1",
             "hf-xet": "1.6.0", "httpx2": "2.16.0",
             "httpcore2": "2.16.0", "truststore": "0.10.5"})
```

Tokenizers remains 0.23.3. Hub 2.4 requires hf-xet `>=1.6,<2`, so the previous
1.4.2 pin cannot be retained. No remaining LTX inference dependency or inspected
source consumer requires the old HTTPX/HTTPCore/Certifi closure. Keep the
verified uv 0.13.7 and November 5 cutoff, audit every artifact, and confirm all
30 unchanged companion blocks per profile are byte-identical. Validation must
exercise the frozen Gemma source/loaders and the native Xet transfer boundary;
an HTTP-only fixture or import check does not prove Xet transfers.

### Wan decoding and font helpers (2026-11-12)

The later bounded Wan refresh changes only `charset-normalizer` to `3.5.2` and
`fonttools` to `4.68.0`. Use the same immutable Wan source, verified uv 0.13.7,
CPython 3.11 Apple Silicon target and November 5 cutoff as above. Derive inputs
from its `project.dependencies`; constrain every existing package version,
changing only these two constraints. Compile the complete closure into a scratch
lock with the command above, then replace only the two target package blocks in
the existing lock. Preserve every unrelated block byte-for-byte, including its
existing artifact allowlist. A fresh resolver may add other-platform hashes to
unchanged packages; that is not part of this update. Validate the complete final
lock's artifact hashes, release cutoff and OSV/MAL results, plus a full target
install plan and native hashed installs of the affected helper subclosures.
