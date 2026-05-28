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

Wire protocol (matches the STAGE:/DOWNLOAD: convention the rest of the
image-gen runners use, so the existing SSE bridge picks it up unchanged):

  STAGE:list                                — fetching file list
  STAGE:download:<n>/<total>:<filename>     — starting file <n> of <total>
  DOWNLOAD:<n>/<total>:<filename>           — same; redundant for the regex
  STAGE:complete:<bytes>                    — done, with total resident bytes
  USER_ERROR:<kind>:<repo>                  — typed error (gated_repo, …)
  ❌ <prose message>                         — paired with USER_ERROR

Exit codes: 0 ok, 2 user-error, 1 unexpected.
"""

import argparse
import os
import sys
from pathlib import Path

# `huggingface_hub` is installed in the FLUX.2 venv (and any mflux venv) —
# the caller picks the python binary that has it. Import errors surface as
# a USER_ERROR with a clear "venv missing huggingface_hub" message so the
# UI can route the user to the FLUX.2 install banner.
try:
    from huggingface_hub import HfApi, hf_hub_download
    from huggingface_hub.utils import GatedRepoError, RepositoryNotFoundError
except Exception as err:  # noqa: BLE001
    print(f"USER_ERROR:venv_missing_hf_hub:{err}", file=sys.stderr, flush=True)
    print("❌ Python venv is missing huggingface_hub. Run the FLUX.2 install from Image Gen settings.", file=sys.stderr, flush=True)
    sys.exit(2)


def main() -> int:
    parser = argparse.ArgumentParser(description="Pre-fetch a HuggingFace repo snapshot.")
    parser.add_argument("--repo", required=True, help="HF repo id, e.g. 'org/name'.")
    parser.add_argument("--revision", default=None, help="Optional revision (branch / tag / sha).")
    parser.add_argument("--token-env", default=None, help="Env var name to read the HF token from (e.g. HF_TOKEN).")
    args = parser.parse_args()

    token = None
    if args.token_env:
        token = os.environ.get(args.token_env) or None
    # huggingface_hub also reads HF_TOKEN itself, but being explicit lets
    # the caller scope which env var the child trusts.

    api = HfApi()
    print("STAGE:list", file=sys.stderr, flush=True)
    try:
        files = api.list_repo_files(args.repo, revision=args.revision, token=token)
    except GatedRepoError:
        print(f"USER_ERROR:gated_repo:{args.repo}", file=sys.stderr, flush=True)
        print(f"❌ Access to {args.repo} is gated. Accept the license at https://huggingface.co/{args.repo} and paste your HuggingFace token into Image Gen settings, then retry.", file=sys.stderr, flush=True)
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
            print(f"❌ HuggingFace rejected the token. Update HF_TOKEN in Image Gen settings.", file=sys.stderr, flush=True)
            return 2
        print(f"USER_ERROR:list_failed:{args.repo}", file=sys.stderr, flush=True)
        print(f"❌ Failed to list {args.repo}: {err}", file=sys.stderr, flush=True)
        return 2

    # Skip the few HF housekeeping files that are not actually downloadable
    # as part of a snapshot (`.gitattributes` is, but `LICENSE` and similar
    # are — we keep them; the only true skip is the `.huggingface` folder).
    files = [f for f in files if not f.startswith(".huggingface/")]
    total = len(files)
    if total == 0:
        print(f"USER_ERROR:repo_empty:{args.repo}", file=sys.stderr, flush=True)
        print(f"❌ Repository {args.repo} reports zero downloadable files.", file=sys.stderr, flush=True)
        return 2

    total_bytes = 0
    for i, filename in enumerate(files, start=1):
        # Stage marker (UI-friendly) + DOWNLOAD: marker (matches the existing
        # mlx_video DOWNLOAD: regex in videoGen/local.js so the same line
        # drives progress in either pipeline).
        print(f"STAGE:download:{i}/{total}:{filename}", file=sys.stderr, flush=True)
        print(f"DOWNLOAD:{i}/{total}:{filename}", file=sys.stderr, flush=True)
        try:
            resolved = hf_hub_download(
                repo_id=args.repo,
                filename=filename,
                revision=args.revision,
                token=token,
            )
        except GatedRepoError:
            print(f"USER_ERROR:gated_repo:{args.repo}", file=sys.stderr, flush=True)
            print(f"❌ {args.repo} is gated. Accept the license + paste your HF token.", file=sys.stderr, flush=True)
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
