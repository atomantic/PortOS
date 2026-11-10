# Upstream MLX video runtime locks

Video Gen Install and Repair use the upstream `uv.lock` at each audited
revision. The installer requires Apple Silicon and a clean checkout at the
shipped revision. A different `*_PIN` value has no supported install profile
until its source and lock have been audited.

| Runtime | Upstream revision | SHA-256 of `uv.lock` |
| --- | --- | --- |
| LTX-2.3 MLX | [dgrauet/ltx-2-mlx at 1192051](https://github.com/dgrauet/ltx-2-mlx/blob/1192051fd380e0501adb5f3c0e9a216e679cb123/uv.lock) | `0dd7510a74a99f13b621b4d4a42ad2b0a07b05f4fe98544313e308c189d3eb54` |
| LTX-2.5 MLX | [MrMoferFRAN/ltx-2-mlx at 5795228](https://github.com/MrMoferFRAN/ltx-2-mlx/blob/57952288076766abe27dda3a774b2c24f7346977/uv.lock) | `d5e10ec955678f72c950b1af5f297d02161fb3f59b38f84493fc06284c5cb1d8` |
| Wan 2.2 MLX | [lpalbou/mlx-gen at 2452f0c](https://github.com/lpalbou/mlx-gen/blob/2452f0c12edcc8886eebf15772205ce9c417a618/uv.lock) | `437647576a6673afb4f94512d8ce59cd504fc203cafe1de613b78006cd2f3033` |

The installer first syncs registry wheels with `--locked --no-build
--no-install-workspace`. It then builds the two LTX inference packages or the
MLX-Gen package from the pinned checkout. The editable builds use
`--no-deps --require-build-hashes` and the separate
[`requirements-mlx-video-build.lock.txt`](../scripts/requirements-mlx-video-build.lock.txt).
This keeps the build dependencies out of the inference environment. Hatchling
1.32+ rejects the workspace-relative README in the pinned LTX-2.3 sources.
Hatchling 1.31.0 and its editable-build dependency are locked for that reason.
MLX-Gen's build backend is `uv-build` 0.7.22, within its upstream declared range.
The build lock header documents regeneration with a seven-day release cutoff.
LTX-2.3 retains MLX 0.31.1. Before changing it, check audio levels because the
0.31.2 release regressed audio peaks on that runtime.

## Audit on 2026-11-10

OSV querybatch covered every registry version in each universal lock, including
versions reachable only via other markers or optional groups. The native column
counts affected registry versions installed by the default Apple Silicon
CPython 3.11 inference profile.

| Runtime | Registry pins audited | Pins with advisories | Affected native pins |
| --- | ---: | ---: | ---: |
| LTX-2.3 MLX | 58 | 12 | 8 |
| LTX-2.5 MLX | 58 | 12 | 8 |
| Wan 2.2 MLX | 112 | 15 | 10 |
| Build constraints | 7 | 0 | 0 |

No MAL records matched. The compatibility-sensitive runtime pin updates and
per-model inference checks are tracked in [#15700](https://github.com/atomantic/PortOS/issues/15700).

To repeat the inventory and OSV/MAL query, check out the corresponding revision
and pass its `uv.lock` and the PortOS build lock to the following script.
Verify the source checkout and lock digest against the table first. The output
includes every package/version and its returned advisory IDs.

```bash
python3.11 - /path/to/checkout/uv.lock scripts/requirements-mlx-video-build.lock.txt <<'PY'
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
build = set(re.findall(r"^([\w-]+)==(\S+)", Path(sys.argv[2]).read_text(), re.M))
pins = sorted(runtime | build)
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

To verify the native subset, use the installer with the chosen runtime flag,
run `uv pip check --python <runtime-venv>/bin/python3`, and compare
`uv pip list --format json --python <runtime-venv>/bin/python3` with the
registry pins. The local checkout packages appear as editable distributions.
When upgrading a source revision, review the updated build backends and
editable dependencies, refresh the digest and inventory, and repeat the
fresh-install, Repair, and model smoke checks.
