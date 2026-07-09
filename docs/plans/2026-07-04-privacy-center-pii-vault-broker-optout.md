# Privacy Center: PII Vault, Trusted-Org Registry, Change-of-Address Inventory, Data-Broker Opt-Out

**Date:** 2026-07-04
**Status:** Design record — tracked as GitHub epic #2138 + child issues #2140–#2148 (see "Phasing → issues" at bottom)
**Prior art:** [unbroker skill](https://github.com/NousResearch/hermes-agent/tree/main/optional-skills/security/unbroker) (hermes-agent, MIT) — concepts adapted, not vendored (it's a Python CLI driven by an external agent; PortOS implements the equivalent natively in Node against its own browser/email/scheduler services).

## Vision

PortOS becomes the system of record for the user's PII and who holds it:

1. **PII Vault** — encrypted-at-rest store of the user's identity facts (legal name, addresses current+previous, phones, emails, DOB, ID documents, financial account stubs), each versioned with validity windows.
2. **Trusted Organizations registry** — every org that has (or had) the user's PII: banks, utilities, government, employers, subscriptions, medical, insurers, platforms — with *which* vault fields each one holds and a trust stance (`trusted | tolerated | unwanted`).
3. **Change-of-address inventory** — declare "field X changed from A to B"; every org holding A flips to `update_pending`; the user works the checklist (manually or with agent-drafted update emails) and always knows what's been changed and what hasn't.
4. **Data-broker opt-out automation** — an unbroker-style autonomous loop: scan people-search brokers for exposure, submit opt-outs (web form + CCPA/GDPR email lanes), poll verifications, re-scan on a schedule, surface human-only tasks in one digest.
5. **Digital Twin augmentation** — the vault becomes the twin's authoritative identity dossier: opt-in per-field context injection for CoS/agents, scan vectors for the broker engine, and cross-linking between the org registry and the twin's `social-accounts.json`.

## What we adopt from unbroker (and what we change)

| unbroker concept | PortOS adaptation |
|---|---|
| Dossier + recorded consent per subject | v1 is **self-only** (the install's one user); an explicit consent/authorization record is still written (audit trail + future household subjects). Schema keeps a `subject` concept but only `self` is implemented. |
| Broker database (curated + BADBOOL + CA Data Broker Registry) | Curated seed JSON in `data.reference/privacy/brokers.json` loaded into Postgres; user-triggered/scheduled refresh service pulls BADBOOL people-search list + CA registry. |
| Tiers T0–T3, `disclosure_fields`, cluster parents | Kept as columns on the broker record. Cluster-parents-first ordering in the planner (one PeopleConnect suppression covers Truthfinder/InstantCheckmate/US Search/…). PeopleConnect `prefer_suppression` exception kept. |
| Ledger state machine + `next_recheck_at` | Postgres `privacy_broker_cases` with service-enforced transitions; every write stamps `next_recheck_at`. |
| Blind opt-out is the default | Kept: submit on every broker with an accessible removal channel even without a confirmed listing (discloses only the subject's own identifiers to the broker's own channel). |
| Least-disclosure + never SSN/ID | Hard-enforced: the engine refuses to emit vault types outside `{full_name, email, phone, city, state, dob, listing_url}` regardless of what a broker form asks. |
| No CAPTCHA/anti-bot defeat | Kept verbatim. Hard challenges → case `blocked` → human digest. No solver services, no fingerprint spoofing. |
| SMTP/IMAP email engine | Replaced by PortOS's `messageSender` (Gmail API) + synced-inbox verification-link scan. Drafts follow the existing approval flow; auto-send only behind an explicit settings toggle. |
| `$PDD next` autonomous loop + cron | Replaced by a service-side run loop + `automationScheduler` cron (user-configured — complies with the no-cold-bootstrap AI policy). |
| `age` encryption (optional) | Field-level AES-256-GCM is **mandatory** for vault values — first encrypted-at-rest layer in PortOS (`server/lib/vaultCrypto.js`). |
| CA DROP one-shot | Surfaced as a first-class recommended action when the subject has a CA address; filing is a human task (gov ID), tracked as a case. |

## Storage classification (per docs/STORAGE.md)

All privacy records are **db-primary** (PostgreSQL): they are app-native relational records with FKs, status/lineage, and cross-record queries ("which orgs hold my old address?", "cases due for recheck"). Vault *values* are stored as AES-256-GCM ciphertext in the row — the DB holds bytes-of-ciphertext, never plaintext PII. Migration slices in `scripts/migrations/` per table group; no new `data/*.json`.

- `privacy_vault_records` — id, `type` (`legal_name|address|phone|email|dob|ssn|passport|drivers_license|financial_account|custom`), `label`, `value_enc` (TEXT, `v1:<iv>:<tag>:<ct>` base64), `masked_value` (precomputed, e.g. `••• St, Portland OR` / `•••-••-1234`), `status` (`current|previous`), `valid_from`, `valid_to`, `share_with_twin` BOOL default false, `use_for_scans` BOOL default (true for name/email/phone/city, false otherwise; ssn/financial/passport hard-false), `notes`, timestamps.
- `privacy_orgs` — id, `name`, `category` (`bank|utility|government|employer|subscription|medical|insurance|platform|broker|other`), `website`, `trust` (`trusted|tolerated|unwanted`), `status` (`active|closed|opted_out`), `contact` JSONB, `social_account_id` (nullable link to digital-twin social account), `notes`, timestamps.
- `privacy_org_holdings` — (org_id FK, vault_record_id FK) PK, `status` (`current|update_pending|updated|removed|unknown`), `noted_at`, `updated_at`. The change-of-address inventory *is* this table grouped by status.
- `privacy_change_events` — id, `vault_record_id` (old), `replacement_record_id` (new, nullable), `kind`, `declared_at`, `note`. Declaring an event flips all `current` holdings of the old record to `update_pending`.
- `privacy_brokers` — id (slug), `name`, `urls` JSONB, `optout` JSONB (`{method, url, email, playbook[], notes}`), `tier` (0–3), `disclosure_fields` TEXT[], `cluster_parent` (nullable self-FK), `prefer_suppression` BOOL, `antibot` BOOL, `source` (`curated|badbool|ca_registry`), `confidence` (`field_verified|documented|auto`), `last_verified`, `enabled` BOOL.
- `privacy_broker_cases` — id, broker_id FK, `state` (see state machine), `found` BOOL nullable, `evidence` JSONB (`{listing_urls[], match_basis}`), `disclosed_fields` TEXT[], `channel`, `reason`, `next_recheck_at`, timestamps.
- `privacy_consents` — id, `subject` (`self`), `scope`, `method`, `granted_at` — audit record written at feature enablement.

**Federation:** deferred (future issue). Privacy tables are machine-local in v1; peer sync of encrypted vault records requires a shared-key story and `schemaVersions.js` gating — explicitly out of scope until the core ships. Backup: covered by whatever covers Postgres today; ciphertext-only rows mean a leaked dump exposes no plaintext PII.

## Encryption model (`server/lib/vaultCrypto.js`)

- AES-256-GCM, per-value random 12-byte IV, ciphertext format `v1:<iv_b64>:<tag_b64>:<ct_b64>` (versioned for future rotation).
- Key: 32 bytes from env `PRIVACY_VAULT_KEY`. On first vault use, if unset, the service generates one and appends it to `.env` (single-user local machine; logged once with an emoji line, value never logged). `.env.example` documents the key. `doctor`-style status endpoint reports whether encryption is engaged.
- Threat model: protects against data-dir/DB-dump/backup/git exposure — not a live root compromise of the running host (key lives on the same machine). Same posture as unbroker's `age` mode; documented in the UI.
- API behavior: list/read endpoints return `masked_value` only. `POST /api/privacy/vault/:id/reveal` returns plaintext (explicit user action). **Vault values never appear in logs** — log record ids/types only.

## Opt-out engine

**State machine** (service-enforced transitions, `server/services/privacyOptOut.js`):

```
unscanned → found | not_found | indirect_exposure | blocked
found/indirect → optout_in_progress → submitted → verification_pending
             → awaiting_processing → confirmed_removed
any → human_task_queued (reason)     confirmed_removed → reappeared (re-scan hit)
```

`confirmed_removed` is only reachable from a verifying re-scan, never from a submission confirmation page. Every write stamps `next_recheck_at` (state-dependent backoff).

**Run loop** (`runOptOutPass()`): compute ordered actions — refresh stale broker cache → scan unscanned (scan vectors derived from vault `use_for_scans` records) → poll verifications → re-check due cases → opt out `found` cluster-parents-first → email `indirect_exposure` cases → requeue `blocked` for a later pass. Human-only work (gov ID, phone callback, fax, hard CAPTCHA) never blocks the loop; it accumulates in a digest.

**Lanes:**
- *Web form:* `browserService` (real Chrome over CDP, persistent profile, SSRF-pinned navigation) drives the broker's `optout.playbook`; submits only `disclosure_fields`; screenshots the confirmation into evidence. Hard interactive challenges → `blocked`, never defeated.
- *Email:* render CCPA/CPRA/GDPR/generic templates (`data.reference/privacy/email-templates/`), recipient locked to the broker record's declared address, create a draft via the messages subsystem. Default: draft requires user approval in Comms (existing `messageSender` contract). Settings toggle `privacy.autoApproveOptOutEmails` (default off) enables standing-authorization auto-send, mirroring unbroker's `autonomy=full`.
- *Verification:* scan the synced Gmail inbox for broker confirmation emails; anti-phishing score (link domain must match the broker record's declared domains) before auto-advancing `submitted → verification_pending`; verification links open in the same CDP browser (several brokers session-bind them).

**Scheduling:** a user-created `automationScheduler` cron (`privacy-recheck`) re-runs the pass over due cases. Never scheduled implicitly — the user turns it on from the UI (sanctioned scheduled-automation exception to the AI-provider policy). LLM usage inside the engine (namesake disambiguation on scan results) only runs inside user-triggered or user-scheduled passes.

**Guardrails (hard, autonomy never overrides):** consent record exists; disclosure limited to the fixed allowlist ∩ broker `disclosure_fields`; no CAPTCHA/anti-bot bypass; if a form demands more than planned mid-flow, the case goes to the digest rather than the engine deciding to disclose extra PII.

## Change-of-address workflow

1. User edits the vault: marks the old address `previous` (sets `valid_to`) and creates the new record — captured as a `privacy_change_events` row (the UI offers "Declare change" which does all three).
2. Every `current` holding referencing the old record flips to `update_pending`.
3. The Changes tab shows the inventory: per-org rows grouped `update_pending / updated / removed`, with per-org actions: mark updated, mark removed, draft an update email (template + org contact, through the same draft-approval flow), open org website.
4. Done = zero `update_pending`. History persists on the event record.

## Digital Twin integration

- Vault records with `share_with_twin` inject into the twin context (`digital-twin-context.js` consumes a new `getPrivacyTwinContext()`), decrypted at injection time only. Gives CoS/agents authoritative identity facts (current address, phone, legal name) for form-filling and drafting.
- The org registry's `platform`-category rows can link to `social-accounts.json` ids (and the accounts UI shows a "in org registry" cross-link) — one merged picture of "who has me."
- The broker engine's scan vectors (names/aliases, emails, phones, city/state history) come from the vault — the twin's identity dossier and the opt-out dossier are the same data, entered once.

## UI

New page `client/src/pages/Privacy.jsx`, route `privacy/:tab`, tabs: `overview | vault | organizations | changes | brokers` (redirect `/privacy` → `/privacy/overview`). Sidebar: children under the existing **Identity** section (Shield icon). All five tab paths get `NAV_COMMANDS` entries (`nav.identity.privacy-*`) per the nav-manifest rule. Client service `client/src/services/apiPrivacy.js`. Mobile-responsive; brokers tab shows the exposure map (state counts), case board, run controls, human-task digest.

## Phasing → issues

Epic: #2138

1. #2140 — Vault core: migration slice + `vaultCrypto` + service/routes/validation
2. #2141 — Trusted-organizations registry + holdings (blocked by 1)
3. #2142 — Privacy UI shell + Vault & Organizations tabs + nav (blocked by 1, 2)
4. #2143 — Change events + inventory workflow + Changes tab (blocked by 2, 3)
5. #2144 — Broker database (seed + refresh) + scan engine + case ledger (blocked by 1)
6. #2145 — Opt-out engine: lanes, verification, scheduling, digest (blocked by 5)
7. #2146 — Brokers UI tab (blocked by 5, 6)
8. #2147 — Digital Twin integration (blocked by 1, 2)
9. #2148 — Future: federation of privacy records + household subjects (`future` label)

## Deferred / open questions

- **Federation**: encrypted vault sync across peers (void/null/NaN/undefined) needs a key-distribution decision (shared `PRIVACY_VAULT_KEY` via user, or per-peer re-encryption). Parked in issue 9.
- **Household subjects**: unbroker manages multiple consenting people; schema leaves room (`privacy_consents.subject`) but v1 is self-only.
- **Cloud/residential browser** for antibot brokers (unbroker's Browserbase lane): out of scope; `blocked` cases stay in the digest with the broker's rights-request email as the rescue lane.
- **Key rotation**: ciphertext format is versioned (`v1:`); a rotation script is trivial to add later, not in v1.
