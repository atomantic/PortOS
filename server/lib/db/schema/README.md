# `server/lib/db/schema/` — per-domain boot DDL

The idempotent `CREATE TABLE` / `CREATE INDEX` / trigger DDL that
`ensureSchemaImpl()` (in `server/lib/db.js`) runs on every boot, split out of
that formerly ~1265-line function into one module per domain (#2832). Each
module exports a plain **statement array**; `index.js` re-exports them and
composes the two ordered lists the composer runs.

**Byte-identical, order-preserving.** These modules were extracted verbatim —
statement text and ordering are unchanged, so the composed schema is identical
to the pre-split inline version. **Order is load-bearing** (FK references, the
`record_audit_log()` function preceding its triggers, and `catalog_user_types`'
original post-media position), so if you add a table, append it in the domain
module and keep the composer order in `index.js` intact.

Parity with `server/scripts/init-db.sql` (the fresh-install path) is locked by
`server/lib/db.ddlParity.test.js`, which auto-discovers all 72 shared tables and
compares columns, indexes, triggers, and functions for each. Two tolerance lists
guard the exceptional cases: `SQL_ONLY_TOLERATED` for tables in init-db.sql but not
JS (the memory system, #1337), and `BOOT_BACKFILL_ONLY` for machine-local tables in
JS but not init-db.sql (with one-line reasons for each).

| Module | Export(s) | Domain |
|---|---|---|
| `core.js` | `coreDdl` | Memory sync columns + the `schema_migrations` version tracker |
| `tribe.js` | `tribeDdl` | Tribe CRM — people, network-scoped identities (`tribe_identities`, the durable-handle truth table behind Beeper linking), touchpoints, memory links (machine-local) |
| `humanActivity.js` | `humanActivityDdl` | Human-activity timeline event store (machine-local) |
| `post.js` | `postDdl` | MeatSpace POST normalized runs and attempts (machine-local) |
| `commissions.js` | `commissionsDdl` | Creative Commissions + feedback (machine-local) |
| `userActions.js` | `userActionsDdl` | Operator-action ledger — what the human did in the UI (machine-local) |
| `aiGraph.js` | `aiGraphDdl` | AI provider connection graph — connections, harness bindings, executable route bindings (machine-local) |
| `catalog.js` | `catalogDdl`, `catalogUserTypesDdl` | Catalog scraps/ingredients/tags/media + user-defined types |
| `media.js` | `mediaDdl` | Creative-director / music-video projects, mood boards, media assets |
| `universes.js` | `universesDdl` | Universes, machine-local character voice profiles/renders, + universe run history |
| `library.js` | `libraryDdl` | Authors, artists, albums, tracks |
| `pipeline.js` | `pipelineDdl` | Pipeline series, issues, story-builder sessions |
| `writersRoom.js` | `writersRoomDdl` | Writers-Room folders, works, draft versions, exercises |
| `lora.js` | `loraDdl` | LoRA training runs |
| `privacy.js` | `privacyDdl` | Privacy suite — vault, consents, orgs, brokers, change events |
| `stackerNews.js` | `stackerNewsDdl` | Stacker News accounts, territories, untrusted-content analyses, and review-gated actions |
| `x.js` | `xDdl` | X account diagnostics, public post metrics, and review-gated drafts |
| `beeper.js` | `beeperDdl` | Beeper conversation mirror — accounts, the vault-encrypted access credential, conversations, messages, participants, attachment metadata, sync cursors, and the outbound send outbox (machine-local, never federated) |
| `audit.js` | `auditDdl`, `auditedTables`, `buildAuditTriggers()` | `record_audit` table/function + per-table audit triggers |

### Composer (`index.js`)

- `buildUpgradeDdl()` → phase-1 list (`core` → `tribe` → `humanActivity` → `post` → `commissions` → `userActions` → `aiGraph`).
- `buildCatalogDdl()` → phase-2 list (`catalog` → `media` → `catalogUserTypes` →
  `universes` → `library` → `pipeline` → `writersRoom` → `lora` → `privacy` → `stackerNews` → `x` →
  `beeper` → `audit` DDL → audit triggers).

`ensureSchemaImpl()` calls these two builders and runs each list through
`pool.query` in order.
