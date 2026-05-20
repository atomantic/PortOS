# Unreleased Changes

## Added

- **CoS task form: pick the reviewer for the Review Loop (`--review-with`).** A new compact dropdown appears next to the Review Loop checkbox in `TaskAddForm.jsx` (copilot / claude / gemini / codex; default copilot). The choice is persisted on the task as `metadata.reviewer` and flows through the agent prompt, the follow-up agent's prompt (`/do:rpr --review-with <reviewer>`), and the worktree cleanup hook — for non-copilot reviewers, PortOS skips the GitHub Copilot reviewer-API pre-request and instructs the follow-up to invoke the chosen CLI against the PR diff instead. AgentCard chips show the selected reviewer when it isn't the default.

## Changed

- **First-run no longer silently flips :5555 from HTTP to self-signed HTTPS.** `scripts/setup-cert.js` ran on every `npm start` and, when Tailscale was unavailable, auto-generated a self-signed cert — breaking the documented `http://localhost:5555` URL and forcing a browser click-through. It now only auto-generates a self-signed cert when (a) the user explicitly passes `--self-signed`, or (b) a self-signed cert is already present (renewal path). Fresh installs without Tailscale stay HTTP-only on :5555 so the URL in the README and in `setup.sh`'s final banner just works. `setup.sh`'s "Access at:" banner is now cert-aware — when HTTPS got provisioned it prints the loopback HTTP mirror (`http://localhost:5553`) and the Tailscale hostname instead of the broken `http://localhost:5555`.

- **PLAN.md — CODEX 5.5 review residue folded in.** Triaged the 2026-04-25 CODEX 5.5 product/engineering review: confirmed the six concrete bugs (Brain Feeds + Time Capsule nav coverage, `/cos/scripts` dead target, `/ask` full-height workaround, client lint, route/nav contract tests) are all shipped, and added 15 unaddressed strategic items to PLAN.md under a new `### CODEX 5.5 review residue` Backlog section (perf/bundle, polling consolidation, client error reporter, network exposure UI, unified Review Queue, health provenance chips, dashboard intent layouts, autonomy guardrails, onboarding capability map, mobile task flows, operating-loop dashboard, sidebar IA collapse, visual modes, decision/provenance pattern, teaching empty states). Enriched the existing Knowledge Legacy Future Idea with the bundle scope from the review.

## Fixed

## Removed

- **`CODEX5.5_REVIEW.md`** at repo root — obsolete now that the concrete bugs are shipped and the strategic items are tracked in PLAN.md.
