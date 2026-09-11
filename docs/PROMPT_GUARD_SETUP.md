# Prompt Guard setup and recovery

Models → LLMs → Abuse Guard shows the failed runtime check, expected package
versions, and the last failed installation stage, diagnosis, and pip exit code.
The last install failure is retained for the server process lifetime; after a
restart, Refresh status still probes the installed packages without inference
or downloads. Repair prefers an already installed `uv` package installer, falling back to
Python pip when uv is unavailable. This supports machines where uv can reach
the package index but Python pip cannot. Repair retries the dedicated runtime without changing the image
or video environments or relaxing screening policy.

For unattended local diagnosis, run from the PortOS checkout:

```sh
node scripts/setup-prompt-guard.js --status
node scripts/setup-prompt-guard.js --install
```

Both commands print JSON to stdout and exit 0 only when ready (1 otherwise).
Install progress goes to stderr. `--status` never installs or runs inference;
`--install` repairs the pinned packages, downloads the model only when its
pinned snapshot is missing, and verifies a complete multi-window benign input.
Cached model repairs work without a Hugging Face token or model download.
When downloading, it uses the same locally configured Hugging Face token as
the UI, without putting the token in command arguments. Run these commands from the primary installation after updating it. CoS
worktrees deliberately use isolated data and ignore `PORTOS_DATA_ROOT`.

Failure codes include `package-missing`, `package-version-mismatch`,
`network-failed`, `certificate-failed`, `wheel-unavailable`, `dependency-conflict`,
and `disk-full`. The first recognized pip error is retained so a connection
failure is not hidden by pip's later “No matching distribution” summary.
Subprocess output is mapped to static messages: tokens, authenticated index
URLs, and local filesystem paths are never returned in setup diagnostics.

For `network-failed`, check Python's access to the configured package index;
a browser or curl succeeding does not prove Python can connect. Restore that
connection and rerun `--install`. For `certificate-failed`, repair certificate
trust rather than disabling TLS verification. Gated Hugging Face access still
requires account approval; a stored token alone does not grant it.

A helper process failure marks the classifier unhealthy until repair succeeds.
Status remains observational and never starts inference or downloads. Run the
existing `--install` command for automated recovery after updating PortOS; it
returns failure if verification fails, so automation must not proceed to review
on a nonzero exit. No repair can bypass a classifier finding.

A previous runner passed the short install canary but failed long PRs with
`security-guard-process-failed`: the installed tokenizer returned only a prefix
of the requested overflow windows. The runner now explicitly disables
truncation while encoding the complete input and slices overlapping windows
from those tokens, preserving full coverage and the pinned special tokens.
