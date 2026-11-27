# Jev setup and recovery

Jev scores which of a fixed list of hypotheses a premise entails. It runs
locally and makes no text-generation call. Enable optional integrations in
**Settings → Features** or **Models → Decision Classifiers → Jev**.
Opening the management page has no installation or model-loading side effects.
See the [decision service ADR](decisions/2026-09-18-local-jev-decision-service.md).

## Install and diagnose

Use **Install** on the Jev page. It provisions a dedicated venv under
`data/python/venv-jev` (fallback `~/.portos/venv-jev`), installs the
hash-locked guard runtime and downloads the ungated 4B checkpoint (about
9.1 GB). The pinned model and expected imports are in `server/lib/jev.js`.
Repair reuses the dedicated environment and does not change Prompt Guard
or image and video environments.

From the primary installation checkout, run:

```sh
node scripts/setup-jev.js --status
node scripts/setup-jev.js --install
```

Both print JSON and exit 0 when ready, 1 otherwise. Install progress goes
to stderr. The status command checks the venv, package imports and cached
model without loading or downloading weights. CoS worktrees use isolated data.

The panel identifies the failed stage (Python, venv, packages or model).
Installation uses PortOS's private hash-verified uv, with pip as a
hash-verified wheel-only fallback. For `network-failed`, check the Python
executable's access to the package index. For `certificate-failed`,
repair certificate trust and keep TLS verification enabled. Free disk
space for `disk-full` and check the expected versions or wheel platform
for package and wheel failures.

## Scoring and recovery

The first scoring call starts one persistent loopback sidecar on port
5566. It unloads after ten idle minutes. Use **Unload now** to release
memory immediately. For `jev-start-failed`, check readiness and available
memory. For `jev-timeout`, check the default 30-second limit and machine
load. A missing dedicated runtime or checkpoint reports
`jev-not-installed`.

A request takes 2–32 hypotheses of at most 512 characters each. The
premise has a 32,000-character cap and the rendered pair must fit the
model window. An oversize premise is refused without truncation.
Callers must honor abstention when the top two probabilities are too close
(default margin 0.15). For an invalid, missing, oversized or unreadable
trained head, discard it to return to the stock scorer. A head revision
mismatch requires retraining or discarding the head.

## Integration policy

Installs, residency and global integration enablement have separate
controls. **Shadow** (legacy stored `off`) scores alongside chat.
**Disabled** suppresses scoring for that source. **Prefer local** uses chat
on abstention or failure. **Local only** skips unresolved items.
The GitHub issue policy covers replies and maintenance. Email shares
action and priority policy. Stacker News remains escalation-only.
On-demand scope adherence produces issue and PR advisories. Completion
goal fidelity stays with the separate Code Reviewers setting.

The panel displays the shipped hypotheses and margin floors. Agreement
measures comparison with chat. Trained heads have separate held-out
evaluation. Prompt Guard continues to screen external content upstream.
See [message security](features/messages-security.md).
