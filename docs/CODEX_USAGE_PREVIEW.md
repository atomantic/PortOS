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

Limits per invocation are 10,000 files, 100,000 directory entries, 256 MiB decoded
bytes, 100,000 accounting records, 1 MiB per line, 16 directory levels and 30
seconds. Byte checks occur at stream chunk boundaries (at most one extra 64 KiB
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
