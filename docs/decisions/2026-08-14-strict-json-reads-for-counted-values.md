# ADR: Strict JSON Reads Wherever a File-Backed Value Is Counted, Displayed, or Written Back

- **Date:** 2026-08-14
- **Status:** Accepted
- **Related:** issue #4115 (this audit), issue #2726 (introduced
  `readJSONFileStrict`, scoped to the Character sheet's file-backed signals),
  [`server/lib/fileUtils.js`](../../server/lib/fileUtils.js),
  [`server/lib/README.md`](../../server/lib/README.md), root `AGENTS.md`
  ("Sentinel + validate to distinguish 'not set / failed' from
  'present-but-empty / valid'").



## Context

A default returned on read failure can appear to be a valid empty count or
be written back over damaged durable data.

## Decision

Use `readJSONFileStrict` when counting, displaying or modifying durable JSON.
ENOENT may initialize a value. Propagate other I/O and parse failures or expose
an explicit unavailable state at the boundary. Validate parsed shape before
treating a value as usable. Use `tryReadFileStrict` for the same distinction
with raw reads. A failed reload can retain a previously valid in-memory value
where the caller can report the failure and prevent unsafe write-back.

## Consequences

Best-effort reads remain appropriate for regenerable caches with no durable
write-back risk. The [JSON write-back guard](../../server/test/JSON_WRITEBACK.md)
inventories non-strict read/write pairs. Review exceptions against their actual
lifecycle. Use [fileUtils.js](../../server/lib/fileUtils.js) for the shared
primitives.
