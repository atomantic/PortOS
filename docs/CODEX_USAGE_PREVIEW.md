# Read-only Codex usage preview

Run an explicit, bounded preview without loading or changing the PortOS usage ledger:

```bash
node scripts/preview-codex-usage.js --from 2026-07-01 --to 2026-07-07
```

Both dates are required, inclusive UTC calendar days, at most 366 days apart
including both endpoints. `--home <synthetic-home>` supplies an isolated home
for tests. There is no apply/write mode, provider call, startup hook or completion
hook. Raw history is never restored to disk. Output is JSON containing only
aggregate coverage, per-model counters, limits and fixed diagnostic codes.
Session IDs, source paths, prompts, working directories and transcript text are
not emitted.

The reader walks `.codex/sessions` and `.codex/archived_sessions`, including
nested `.jsonl` and `.jsonl.zst` files. It does not filter filenames by date:
a session started earlier can contain usage during the requested interval.
Native `node:zlib` Zstandard streaming support is detected at runtime; a runtime
without it reports `unsupported_compression` and incomplete coverage. It never
installs a decoder or launches a subprocess. Symlinks are not followed.

Streaming retains only accounting metadata: hashed logical session identity,
model, timestamps, assistant-message markers and cumulative token counters.
`parseCodexRollout` supplies the existing counter semantics, including subtracting
the last pre-window baseline and separating cached input. Repeated cumulative
snapshots are not summed. Existing parser model attribution is preserved (the
first recorded model owns the rollout); this preview does not establish new
per-turn attribution.

Copies with the same logical session ID and identical ordered accounting
metadata contribute once, including moved and raw/compressed copies. Copies with
different accounting metadata are conservatively unresolved, even when one is
an older prefix. A malformed, truncated, unreadable, over-limit or changing source
is excluded. When its identity can be read, all copies of that identity are
excluded. If identity cannot be recovered, coverage remains incomplete and
unseen duplicate/conflict relationships remain unknown. Irrelevant transcript
content does not affect the accounting fingerprint, but malformed JSON anywhere
in the source invalidates it. Missing source directories are legitimate empty
coverage; inaccessible directories are incomplete coverage.

Limits per invocation are 10,000 files, 100,000 directory entries, 256 GiB decoded
bytes, 100,000 accounting records, 1 MiB per line, 16 directory levels and 30
seconds. The decoded-byte limit is a CPU backstop, so the 30-second deadline is the
ceiling a real scan meets: lines without accounting data are skipped from their
prefix and never buffered, and memory is bound by the record limit. An earlier 256
MiB limit reported even a one-day window as incomplete on a heavy install. Byte checks occur at stream chunk boundaries (at most one extra 64 KiB
raw or 16 KiB decoded chunk, included in `decodedBytes`); over-budget chunks are
never parsed. The reusable `previewCodexUsage` service accepts lower positive limits
and an `AbortSignal`; callers cannot disable or raise the caps. SIGINT/SIGTERM
cancel the CLI. Reads stop at a captured file extent and changed size/timestamps
or identity invalidate the source. Filesystem operations finish at their OS
boundary; cancellation/deadlines are checked between operations and abort active
streams. Concurrent filesystem edits mean this is an inspection, not an atomic
history snapshot.

Exit code 0 means complete coverage of discovered supported sources, 2 means
incomplete coverage, 130 means cancelled, and 1 means invalid arguments or a
command failure. Resolved-source totals can still appear with incomplete
coverage: inspect `coverage.complete`, `coverage.issues` and `stopped` before
using them. Integer overflow produces null totals instead of rounded counts.

**Observed counters are not proven missing usage.** `ledgerOverlap: "unknown"`
and `missingUsage: null` are intentional. The preview cannot establish what a
prior run already attributed to the live ledger, and must not be treated as a
backfill amount. Reader integration and provable ledger application are separate
work under #15030 and #15031.

## Routine accounting

Run reconciliation and the native history reader read the same sources under separate
limits, so these do not change what a preview reports. Each pass decodes at most
5,000 unindexed files, 64 GiB or 20 seconds of work and stores each verified
projection (see [Storage](./STORAGE.md#codex-accounting-source-inventory)). Sources
already stored spend none of that budget. A pass that leaves work reports
`indexing_pending` with counts, holds the Codex native-history fold and run claims, and the next
pass continues, so a history larger than one pass converges. A single source is
limited to 100,000 accounting records; a larger one holds accounting until it is
resolved, and only that source is reported.

Concurrent passes share a running decode of the same source revision. Each pass
keeps its own window and walks the tree itself, so a caller never receives a
narrower result or one read before its own request.

Logs carry reasons and counts only. The Usage page notice also names up to five
sources that could not be read, by path relative to the Codex home, because those
are what you need to repair. It is served only to an operator session: the
federated usage digest and the peer API surface do not include it.

## Usage page preview

The Usage page includes **Preview Codex history before repair** beside the existing historical reconciliation controls. Enter an inclusive UTC date interval (at most 366 days), then choose **Preview sources**. The scan runs in the existing background worker and can be cancelled without changing recorded usage. Source coverage, conflicting copies, observed counters and unknown ledger overlap are shown separately. This preview does not invoke the existing **Reconcile now** repair action.

The preview is inspection only. No apply action is offered: recovered counters, legacy run timestamps and standalone scan watermarks do not establish exact previous attribution. Even newer cumulative high-water markers do not reconstruct historical per-model/day contributions. Issue #15031 remains open for evidence-bound repair, source/ledger revision validation and an explicit apply flow once a positive adjustment can be proved. Do not infer missing usage by subtracting arbitrary aggregate totals or by treating absent markers as proof.
