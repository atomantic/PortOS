# ADR: AI Usage Metrics Federate, On By Default

- **Date:** 2026-09-01
- **Status:** Accepted
- **Related:**
  [`server/services/peerUsage.js`](../../server/services/peerUsage.js),
  [`server/services/usage.js`](../../server/services/usage.js) (`buildUsageDigest`),
  [`server/services/dataSync.js`](../../server/services/dataSync.js) (`usage` category),
  ADR [privacy records machine-local](./2026-08-08-privacy-records-machine-local.md),
  ADR [federated visual prompts](./2026-08-20-federated-visual-prompts.md).



## Context

The owner's installs record usage independently. The dashboard needs fleet
visibility while preserving per-machine counts and the locality of raw records.

## Decision

The `usage` category defaults on within configured sync. Existing peer
approval, master switch and category settings control it. Each instance owns
its digest. Validate and rebuild incoming slots to bounded wire shapes, apply
newer timestamps and tombstones, and keep source-machine attribution. Never
write received metrics back into the local usage ledger.

The digest contains aggregate counts and model IDs, with optional quota cards
and daily Claude Code model token counts. Prompt text, transcripts, session IDs,
project paths and account credentials stay local. Quotas are readings recorded
locally from ordinary provider workflows. Locally retained app histories fold
into daily stores and enter the digest from there. No federation read calls a
model or launches a provider fetch.

## Consequences

Absent peer data remains unknown. Legacy peers may omit additive fields.
Native report v1/v2 exchange is retired (#15272), and older payloads carrying
the retired cutover stamp are skipped (#15279). Local history and peer history
are reported as aggregates with provenance, without implying shared ledgers.
