# jev setup and recovery

**jev** is PortOS's local *entailment scorer*: give it a premise and a list of
hypotheses, get back a per-hypothesis entailment distribution and an argmax with
a confidence margin. It answers **closed-set questions** — "which of these
options does this text entail?" — with no text generation, no tool surface, and
no provider quota. See the ADR
[local jev decision service](./decisions/2026-09-18-local-jev-decision-service.md)
for why it exists and what was rejected.

It is an **optional** feature, off by default. Turn it on in **Settings >
Features** or **Models > LLMs > jev**. The management page and navigation stay
visible at `/models/llms/jev` even when integrations are disabled. Browsing the
page never installs or loads the model.

## What gets installed

| | |
|---|---|
| Model | `AlexWortega/openjev`, subfolder `qwen3.5-4b-nli`, revision `f8187e6e11d413d0771bcc7970b85f78e194264c` |
| License | MIT, ungated — **no Hugging Face token or model-card approval** |
| Download | 4 files, ~9.1 GB (weights dominate). The repository's 35B variant, its trained MLP heads, and its `code/` directory are never fetched and never executed |
| Runtime | A dedicated virtualenv at `data/python/venv-jev` (fallback `~/.portos/venv-jev`) — separate from Prompt Guard's and from the image/video runtimes |
| Packages | `torch`, `transformers`, `safetensors`, `huggingface_hub`, pinned in `server/lib/jev.js` |
| Port | `PORTS.JEV` = 5566, loopback only, bound on demand |

Nothing above happens at boot, on a status refresh, or on first request. The
download runs only from an explicit operator install.

## Install and diagnose

Models → LLMs → jev shows the four install stages (`python`, `venv`,
`packages`, `model`), the failed runtime check, expected package versions, and
the last failed installation stage with its diagnosis. Overall **ready** is true
only when the pinned packages import *and* the pinned snapshot is cached.

For unattended local diagnosis, run from the PortOS checkout:

```sh
node scripts/setup-jev.js --status
node scripts/setup-jev.js --install
```

Both print JSON to stdout and exit 0 only when ready (1 otherwise). Install
progress goes to stderr. `--status` never installs, downloads, or loads a model.
Run these from the primary installation after updating it — CoS worktrees
deliberately use isolated data and ignore `PORTOS_DATA_ROOT`.

Install prefers an already-installed `uv` package installer and falls back to
Python pip, for machines where uv can reach the package index but pip cannot.
Repair retries the dedicated runtime without touching Prompt Guard or the image
and video environments.

## The sidecar

Unlike Prompt Guard, which spawns a Python process per scanned item, jev runs a
**persistent sidecar**: `scripts/run_jev.py` binds `127.0.0.1:5566`, loads the
checkpoint once, and answers JSON scoring requests. A 4B model is far too
expensive to re-import per call.

- It starts on the **first scoring call**, never at boot.
- Two concurrent first callers produce exactly one process.
- An idle timer unloads it after **10 minutes**; **Unload now** on the panel
  frees it immediately.
- It refuses to start without its model directory, refuses a non-loopback peer,
  and refuses a premise that exceeds the model window rather than truncating and
  answering about the prefix.
- It never echoes the premise or a hypothesis back in an error, and its stderr
  is drained but never retained — a dependency traceback can carry local paths
  or the input itself.

## Abstention is the contract

`decide()` returns `abstained: true` whenever the margin between the top two
options' entailment probabilities falls below the threshold (default `0.15`).

**A caller must treat abstention as "ask something else" — never as "take the
top one anyway."** The margin is the entire difference between "the model
distinguished these options" and "the model produced a number". A caller that
wants an additional floor beneath a clear-but-weak winner applies it on top of
the reported `confidence`; the service itself gates on margin alone.

The margin needs a runner-up, so `decide()` requires **at least two options**. A
yes/no question is expressed as two hypotheses (`"…warrants a reply"` /
`"…warrants no reply"`), not one.

## Failure codes

Codes, never text. A Python traceback can carry local paths or the premise, so
nothing from the sidecar's stderr ever reaches a payload or a log line.

| Code | Meaning |
|---|---|
| `jev-not-installed` | No dedicated virtualenv, or the pinned snapshot is not cached. Install from Models → LLMs → jev. |
| `jev-start-failed` | The sidecar could not be started, or died before reporting a loaded model. Check the install stages, then free memory — the checkpoint needs roughly its 9 GB on disk plus room to load. |
| `jev-timeout` | A scoring request exceeded its timeout (default 30 s). |
| `jev-request-invalid` | The premise or hypothesis list failed the bounds in `server/lib/jev.js`, or fewer than two options reached `decide()`. |
| `jev-response-invalid` | The sidecar's reply did not match the wire schema, or described a different hypothesis list than the one asked about. |
| `jev-premise-too-large` | The premise exceeded 32,000 characters, or the rendered pair exceeded the model window. The request is refused, not truncated. |

Install-stage failures reuse the shared Python diagnosis vocabulary —
`package-missing`, `package-version-mismatch`, `network-failed`,
`certificate-failed`, `wheel-unavailable`, `dependency-conflict`, `disk-full`
(`server/lib/pythonRuntimeDiagnosis.js`). For `network-failed`, check Python's
access to the configured package index; a browser or curl succeeding does not
prove Python can connect. For `certificate-failed`, repair certificate trust
rather than disabling TLS verification.

## Bounds

Declared once in `server/lib/jev.js` and mirrored into `scripts/run_jev.py` so
the boundary still holds if the script is invoked directly:

| | |
|---|---|
| Premise | 32,000 characters |
| Hypotheses | 32 per request, 512 characters each |
| Default margin | 0.15 |
| Request timeout | 30 s |
| Idle unload | 10 minutes |

## What jev is not

It is **not selectable as a chat provider**. The descriptor is exposed beside
the catalog under its own `decisionScorers` key — the same guarantee
`securityGuards` gives Prompt Guard — and is never merged into `models`, so no
provider or model picker can offer it.

It is also not a replacement for the abuse guard. Prompt Guard screens external
content *before* anything reasons over it; jev is one of the things that may
then reason over it. See [features/messages-security.md](./features/messages-security.md).

## Integration management

The Jev page separates installation, model residency, global integration enablement,
and source policies. Source `off` retains its legacy meaning: **Shadow**, scoring
alongside chat for comparison. **Disabled** (`disabled`) actually suppresses scoring
for that source. **Prefer local** uses chat on abstention/failure; **Local only**
skips unresolved items. Existing policies are unchanged until explicitly edited.

Issue replies and forge maintenance share the GitHub issue policy; message action
and priority share email policy; Stacker News classification and risk share its
policy and remain escalation-only. Scope adherence has a separate on-demand switch
(default enabled under the global gate). It provides issue/PR advisories, not agent
completion grades. Completion goal fidelity remains the separate chat reviewer in
Models > Code Reviewers, with forge verification for merge objectives.

The page displays the shipped hypotheses directly from the decision registry and
explains margin floors. Agreement is comparison with chat, not measured correctness;
missing comparisons are not zero accuracy. Metrics and runtime status refresh while
the page is visible. Trained-head evaluation remains a separate held-out comparison.
