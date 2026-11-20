#!/usr/bin/env python3
"""
PortOS HuggingFace snapshot pre-fetch.

Downloads a full HF repo into the standard `~/.cache/huggingface/hub/` cache
so the image / video gen forms can show a model as "Available" instead of
forcing the user to discover a multi-GB pull mid-render. Spawned over SSE
from `GET /api/image-gen/models/:id/download` and the matching
`GET /api/video-gen/models/:id/download` (model-id-keyed; the route maps
the id to an HF repo before invoking this helper), plus
`GET /api/video-gen/text-encoder/download` for the Gemma encoder.

`--only <filename>` (repeatable) switches to SINGLE-FILE mode: the repo is
never enumerated and exactly the named files are fetched. That is the only
safe way to pull one weight out of a multi-hundred-GB aggregate repo (e.g. the
`DeepBeepMeep/LTX-2` mirror, ~708 GB) — a snapshot of that would fill the
user's disk. Prefer it whenever the caller already knows the exact filename.

Wire protocol (matches the STAGE:/DOWNLOAD: convention the rest of the
image-gen runners use, so the existing SSE bridge picks it up unchanged):

  STAGE:list                                — fetching file list
  STAGE:download:<n>/<total>:<filename>     — starting file <n> of <total>
  STAGE:bytes:<n>/<total>:<got>/<size>:<filename>
                                            — byte progress for the current file
  STAGE:verify:<n>/<total>:<filename>       — transfer done; committing/hashing
  DOWNLOAD:<n>/<total>:<filename>           — same; redundant for the regex
  STAGE:complete:<bytes>                    — done, with total resident bytes
  USER_ERROR:<kind>:<repo>                  — typed error (gated_repo, …)
  ❌ <prose message>                         — paired with USER_ERROR

Exit codes: 0 ok, 2 user-error, 1 unexpected.
"""

import argparse
import inspect
import os
import sys
import threading
from pathlib import Path


# --- Pure helpers (importable without huggingface_hub; covered by the JS suite
# that loads this file via importlib). Keep them above the hub import so a
# missing hub package cannot prevent the tests from reaching them.

def repo_cache_dir(repo_id, cache_root):
    """HF hub folder for a repo: `<cache_root>/models--org--name`."""
    return Path(cache_root) / f"models--{str(repo_id).replace('/', '--')}"


def incomplete_bytes(cache_dir):
    """Sum of `*.incomplete` sizes under a repo cache dir (0 if none)."""
    root = Path(cache_dir)
    if not root.is_dir():
        return 0
    total = 0
    for path in root.rglob("*.incomplete"):
        try:
            total += path.stat().st_size
        except OSError:
            pass
    return total


def format_bytes_stage(step, total_files, downloaded, total_bytes, filename):
    return (
        f"STAGE:bytes:{int(step)}/{int(total_files)}:"
        f"{int(downloaded)}/{int(total_bytes)}:{filename}"
    )


def format_verify_stage(step, total_files, filename):
    return f"STAGE:verify:{int(step)}/{int(total_files)}:{filename}"


class ByteProgressWatcher:
    """Poll the HF incomplete blob and emit STAGE:bytes / STAGE:verify.

    huggingface_hub (HTTP and xet) writes the in-flight weight to
    `*.incomplete` under the repo cache. File-count progress is 1/1 the moment
    a single-file pull starts, which made a 50 GB conditioner look "done" for
    the entire transfer. This watcher is the byte signal the badge needs.

    When the incomplete file disappears after having grown, the hub is
    committing/hashing — emit STAGE:verify so the UI does not sit on a stale
    "Downloading… 100%" with no further movement.
    """

    def __init__(self, cache_dir, filename, step, total_files, expected, interval=0.5):
        self.cache_dir = Path(cache_dir)
        self.filename = filename
        self.step = step
        self.total_files = total_files
        self.expected = int(expected or 0)
        self.interval = interval
        self._stop = threading.Event()
        self._thread = None
        self._last_n = 0
        self._saw_bytes = False

    def _emit_bytes(self, n):
        print(
            format_bytes_stage(self.step, self.total_files, n, self.expected, self.filename),
            file=sys.stderr,
            flush=True,
        )

    def _run(self):
        n = incomplete_bytes(self.cache_dir)
        self._last_n = n
        if n > 0:
            self._saw_bytes = True
        self._emit_bytes(n)
        while not self._stop.wait(self.interval):
            n = incomplete_bytes(self.cache_dir)
            if n > 0:
                self._saw_bytes = True
            if n == 0 and self._saw_bytes:
                # Transfer finished; hub is renaming + hashing the blob.
                self._emit_bytes(self.expected or self._last_n)
                print(
                    format_verify_stage(self.step, self.total_files, self.filename),
                    file=sys.stderr,
                    flush=True,
                )
                self._stop.wait()
                return
            if n != self._last_n:
                self._last_n = n
                self._emit_bytes(n)

    def start(self):
        self._thread = threading.Thread(target=self._run, name="hf-byte-progress", daemon=True)
        self._thread.start()

    def stop(self):
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=2)

    def __enter__(self):
        self.start()
        return self

    def __exit__(self, *exc):
        self.stop()
        return False


def _hub_cache_root():
    # huggingface_hub.constants.HF_HUB_CACHE already honors HF_HUB_CACHE /
    # HF_HOME. Importing here (not at module load) keeps the helpers above
    # testable without the package.
    from huggingface_hub.constants import HF_HUB_CACHE
    return HF_HUB_CACHE


def _expected_file_size(repo, filename, revision, token):
    try:
        from huggingface_hub import get_hf_file_metadata, hf_hub_url
        meta = get_hf_file_metadata(
            hf_hub_url(repo_id=repo, filename=filename, revision=revision),
            token=token,
        )
        size = getattr(meta, "size", None)
        return int(size) if size else 0
    except Exception:  # noqa: BLE001
        return 0


def main() -> int:
    # `huggingface_hub` is installed in the FLUX.2 venv (and any mflux venv) —
    # the caller picks the python binary that has it. Import errors surface as
    # a USER_ERROR with a clear "runtime missing huggingface_hub" message so the
    # UI can route the user to the applicable model setup panel.
    try:
        from huggingface_hub import HfApi, hf_hub_download
        from huggingface_hub.utils import GatedRepoError, RepositoryNotFoundError
    except Exception as err:  # noqa: BLE001
        print(f"USER_ERROR:venv_missing_hf_hub:{err}", file=sys.stderr, flush=True)
        print("❌ The selected model runtime is missing huggingface_hub. Use Install / Repair in the Media Generation UI.", file=sys.stderr, flush=True)
        return 2

    # `hf_hub_download(..., local_dir=...)` defaulted to populating `local_dir`
    # via symlinks into the HF cache on huggingface_hub < 0.23, which would
    # break BYOV installers (HiDream-O1) that need real on-disk files. Force
    # real copies with `local_dir_use_symlinks=False`. Newer huggingface_hub
    # (>= 0.23) deprecated the kwarg and always copies, eventually removing
    # it — probe the signature so we only pass it where it's still accepted.
    accepts_symlink_kwarg = (
        "local_dir_use_symlinks" in inspect.signature(hf_hub_download).parameters
    )

    parser = argparse.ArgumentParser(description="Pre-fetch a HuggingFace repo snapshot.")
    parser.add_argument("--repo", required=True, help="HF repo id, e.g. 'org/name'.")
    parser.add_argument("--revision", default=None, help="Optional revision (branch / tag / sha).")
    parser.add_argument("--token-env", default=None, help="Env var name to read the HF token from (e.g. HF_TOKEN).")
    parser.add_argument("--local-dir", default=None, help="If set, materialize the repo as a flat copy at this dir instead of relying on the standard HF cache symlinks (used by BYOV installers like HiDream-O1 that need a real on-disk repo).")
    parser.add_argument("--ignore", action="append", default=[], help="Glob pattern (fnmatch) to skip from the file list. Repeat for multiple patterns. e.g. --ignore 'scripts/**' --ignore 'docs/**' to skip non-weight subdirs.")
    parser.add_argument("--only", action="append", default=[], metavar="FILENAME",
                        help="Fetch ONLY this exact repo-relative filename, skipping repo enumeration "
                             "entirely. Repeat for several files. Required for aggregate repos where a "
                             "snapshot would be catastrophic (e.g. the ~708 GB DeepBeepMeep/LTX-2 mirror). "
                             "Mutually exclusive with --ignore, which only filters an enumerated list.")
    args = parser.parse_args()

    if args.only and args.ignore:
        print("USER_ERROR:bad_args:only_with_ignore", file=sys.stderr, flush=True)
        print("❌ --only and --ignore are mutually exclusive (--only never enumerates the repo).", file=sys.stderr, flush=True)
        return 2

    token = None
    if args.token_env:
        token = os.environ.get(args.token_env) or None
    # huggingface_hub also reads HF_TOKEN itself, but being explicit lets
    # the caller scope which env var the child trusts.

    if args.only:
        # SINGLE-FILE mode. Deliberately skips `list_repo_files` — enumerating a
        # 125-file/708 GB aggregate repo is wasted work, and more importantly the
        # absence of a list means no code path downstream can widen this into a
        # whole-repo pull. A typo'd filename surfaces as download_failed (HF 404)
        # rather than being silently dropped from a filtered list.
        files = list(dict.fromkeys(args.only))
    else:
        api = HfApi()
        print("STAGE:list", file=sys.stderr, flush=True)
        try:
            files = api.list_repo_files(args.repo, revision=args.revision, token=token)
        except GatedRepoError:
            print(f"USER_ERROR:gated_repo:{args.repo}", file=sys.stderr, flush=True)
            print(f"❌ Access to {args.repo} is gated. Accept the license at https://huggingface.co/{args.repo} and save your Hugging Face token in Media Generation settings, then retry.", file=sys.stderr, flush=True)
            return 2
        except RepositoryNotFoundError:
            print(f"USER_ERROR:repo_not_found:{args.repo}", file=sys.stderr, flush=True)
            print(f"❌ Repository {args.repo} not found on HuggingFace.", file=sys.stderr, flush=True)
            return 2
        except Exception as err:  # noqa: BLE001
            # Anything that smells like 401 from list_repo_files — surface it
            # as token-rejected so the UI can prompt for a new HF_TOKEN.
            if "401" in str(err) or "Unauthorized" in str(err):
                print(f"USER_ERROR:hf_unauthorized:{args.repo}", file=sys.stderr, flush=True)
                print("❌ Hugging Face rejected the token. Replace it in Media Generation settings, then retry.", file=sys.stderr, flush=True)
                return 2
            print(f"USER_ERROR:list_failed:{args.repo}", file=sys.stderr, flush=True)
            print(f"❌ Failed to list {args.repo}: {err}", file=sys.stderr, flush=True)
            return 2

        # Skip the few HF housekeeping files that are not actually downloadable
        # as part of a snapshot (`.gitattributes` is, but `LICENSE` and similar
        # are — we keep them; the only true skip is the `.huggingface` folder).
        files = [f for f in files if not f.startswith(".huggingface/")]
        if args.ignore:
            import fnmatch
            files = [f for f in files if not any(fnmatch.fnmatch(f, pat) for pat in args.ignore)]

    total = len(files)
    if total == 0:
        print(f"USER_ERROR:repo_empty:{args.repo}", file=sys.stderr, flush=True)
        print(f"❌ Repository {args.repo} reports zero downloadable files.", file=sys.stderr, flush=True)
        return 2

    cache_dir = repo_cache_dir(args.repo, _hub_cache_root())
    total_bytes = 0
    for i, filename in enumerate(files, start=1):
        # Stage marker (UI-friendly) + DOWNLOAD: marker (matches the existing
        # mlx_video DOWNLOAD: regex in videoGen/local.js so the same line
        # drives progress in either pipeline).
        print(f"STAGE:download:{i}/{total}:{filename}", file=sys.stderr, flush=True)
        print(f"DOWNLOAD:{i}/{total}:{filename}", file=sys.stderr, flush=True)
        download_kwargs = {
            "repo_id": args.repo,
            "filename": filename,
            "revision": args.revision,
            "token": token,
            "local_dir": args.local_dir,
        }
        # Only force copies when the caller actually asked for a flat
        # on-disk layout — without `--local-dir`, hf_hub_download writes
        # into the standard HF cache where symlinks are the contract.
        if args.local_dir and accepts_symlink_kwarg:
            download_kwargs["local_dir_use_symlinks"] = False
        expected = _expected_file_size(args.repo, filename, args.revision, token)
        try:
            with ByteProgressWatcher(cache_dir, filename, i, total, expected):
                resolved = hf_hub_download(**download_kwargs)
        except GatedRepoError:
            print(f"USER_ERROR:gated_repo:{args.repo}", file=sys.stderr, flush=True)
            print(f"❌ {args.repo} is gated. Accept its license, save your Hugging Face token in Media Generation settings, then retry.", file=sys.stderr, flush=True)
            return 2
        except Exception as err:  # noqa: BLE001
            print(f"USER_ERROR:download_failed:{filename}", file=sys.stderr, flush=True)
            print(f"❌ Failed to download {filename}: {err}", file=sys.stderr, flush=True)
            return 2
        # Sum sizes for the completion event so the UI can show the resident
        # bytes total — matches what the cache inspector returns server-side.
        try:
            total_bytes += Path(resolved).stat().st_size
        except OSError:
            pass

    print(f"STAGE:complete:{total_bytes}", file=sys.stderr, flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
