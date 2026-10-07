# ADR: Keep full-bypass permissions for unattended CoS task agents

**Date:** 2026-10-06
**Status:** Accepted — no change to the default posture

## Question

CoS task agents launch with each vendor's "skip every approval" switch
(`claude --dangerously-skip-permissions`, `codex --dangerously-bypass-approvals-and-sandbox`,
`agy --dangerously-skip-permissions`, grok `--permission-mode bypassPermissions`,
cursor `--force`, kimi TUI `--yolo`). Several vendors now ship a middle mode
that auto-approves routine actions and gates the rest: Claude Code
`--permission-mode auto` (a classifier judges each action), Codex
`--approve-for-me` (automatic review inside a workspace-write sandbox), and
`acceptEdits`-class modes. Should unattended agents move to those?

## Decision

**No — bypass stays the default for unattended CoS agents.** An approval mode is
only safer when something can answer the escalation. A CoS agent has nobody to
answer it ([ETHOS.md](../../ETHOS.md): unsupervised operation is the design
target), so a blocked action is not "asked and resolved", it is a stalled or
failed run.

## Why

- **A denial is a dead end.** In headless `-p` / PTY runs a classifier block or
  sandbox denial either aborts the session after repeated blocks or leaves the
  agent retrying around the refusal. The Completion Workflow routinely does what
  such classifiers treat as sensitive: `git push`, `gh pr merge --delete-branch`,
  deleting a remote branch, hitting PortOS's own API with `PORTOS_API_TOKEN`,
  `npm`/`gh` network access. Each would become a flaky stop with no operator.
- **Codex's `--approve-for-me` runs in a workspace-write sandbox**, which
  withholds the network the agent needs for `gh`, `git push`, and installs.
  Claude's sandbox posture is already used where it fits: the *public-review*
  recipes (`CLAUDE_PUBLIC_REVIEW_*` in `server/lib/providerVendors.js`) pin
  `plan`/`acceptEdits` plus an OS sandbox because that stage handles untrusted
  PR content and needs no network.
- **Auto mode is not universally available.** Claude's classifier depends on
  plan, model, and API provider; local-model wrappers (Ollama/LM Studio) and
  third-party endpoints do not have it. A fleet-wide default would silently
  differ per provider, and agy has only bypass or `--sandbox` (terminal
  restrictions, no auto-approve tier).
- **Containment already lives in the harness**, not the approval prompt: an
  isolated git worktree per task, the guarded `pm2` shim
  (`server/lib/agentGuard/`), `commandSecurity.js` policies, loopback-scoped
  `PORTOS_API_TOKEN`, and the no-public-exposure rule in AGENTS.md. A classifier
  adds latency, token cost, and non-determinism on every tool call without
  covering a threat those guards do not.
- **Honest limit:** bypass means an agent that is prompt-injected by repo or web
  content can act with the host user's privileges. That is the accepted
  single-user trust model; the mitigation is the guards above and keeping
  untrusted-content stages (public review) on the hardened recipes, not an
  approval prompt nobody reads.

## Where a stricter mode is appropriate

- Untrusted-content stages: already `plan` / `acceptEdits` + sandbox.
- A user who wants auto mode for an interactive-attached session can pin it in
  `provider.args`. Codex and kimi already skip their injected bypass when the
  argv declares a posture (`codexHasApprovalPolicy`); the Claude headless
  builder (`claudeSpawnArgs`) always prepends `--dangerously-skip-permissions`,
  so that override is not yet honored — tracked as a follow-up.

## Revisit when

A vendor's auto mode runs headless with a documented non-aborting fallback, works
on every provider PortOS routes to, and permits the network/git operations the
Completion Workflow needs without per-action escalation.
