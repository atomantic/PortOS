# Unreleased Changes

## Added

## Changed

- **First-run no longer silently flips :5555 from HTTP to self-signed HTTPS.** `scripts/setup-cert.js` ran on every `npm start` and, when Tailscale was unavailable, auto-generated a self-signed cert — breaking the documented `http://localhost:5555` URL and forcing a browser click-through. It now only auto-generates a self-signed cert when (a) the user explicitly passes `--self-signed`, or (b) a self-signed cert is already present (renewal path). Fresh installs without Tailscale stay HTTP-only on :5555 so the URL in the README and in `setup.sh`'s final banner just works. `setup.sh`'s "Access at:" banner is now cert-aware — when HTTPS got provisioned it prints the loopback HTTP mirror (`http://localhost:5553`) and the Tailscale hostname instead of the broken `http://localhost:5555`.

- **PLAN.md — CODEX 5.5 review residue folded in.** Triaged the 2026-04-25 CODEX 5.5 product/engineering review: confirmed the six concrete bugs (Brain Feeds + Time Capsule nav coverage, `/cos/scripts` dead target, `/ask` full-height workaround, client lint, route/nav contract tests) are all shipped, and added 15 unaddressed strategic items to PLAN.md under a new `### CODEX 5.5 review residue` Backlog section (perf/bundle, polling consolidation, client error reporter, network exposure UI, unified Review Queue, health provenance chips, dashboard intent layouts, autonomy guardrails, onboarding capability map, mobile task flows, operating-loop dashboard, sidebar IA collapse, visual modes, decision/provenance pattern, teaching empty states). Enriched the existing Knowledge Legacy Future Idea with the bundle scope from the review.

## Fixed

- **Sharing/annotation-merge hardening — 5 v2.1.0 residue items.** Outgoing annotation manifests now honor per-bucket `displayNameOverride` (previously all buckets got the global name); peer payloads with missing/invalid `updatedAt` are dropped on import instead of winning LWW via a `now`-fallback; future-skewed peer timestamps are clamped to local-now to stop one bad clock from ratcheting every subsequent merge; `peerInstanceId === 'unknown'` (or empty) is refused on import to match the existing outgoing-path guard; and `exportAnnotationsToBucket` now skips both the asset-dir scan AND the record write when local has no annotations and no prior record exists, so a fresh-install annotation edit doesn't fan an empty manifest into every auto-merge bucket.

## Removed

- **`CODEX5.5_REVIEW.md`** at repo root — obsolete now that the concrete bugs are shipped and the strategic items are tracked in PLAN.md.
