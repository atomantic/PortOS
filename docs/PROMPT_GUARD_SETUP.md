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
`--install` explicitly downloads the pinned packages and model and runs the
benign end-to-end verification. It uses the same locally configured Hugging
Face token as the UI, without putting the token in command arguments. Run these commands from the primary installation after updating it. CoS
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
