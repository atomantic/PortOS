# Compact, versioned quality snapshots

Status: implemented. The file schema lives in
`server/services/appQualitySnapshotFormat.js`. Tracked by
[#8038](https://github.com/atomantic/PortOS/issues/8038).

## Context

`.quality.json` is a checked-in release artifact, not the authoritative quality
history. The authoritative history already lives in the PostgreSQL
`app_quality_measurements` table. The publisher projects a bounded window into
the file: one winning assessment per UTC day and category for the 30-day
lookback. That means the file is bounded today, but its current object-per-row
representation repeats report property names and carries an opaque
`measurementId` that is not needed to display a daily value.

The current file also serves two contracts at once. The federation payload and
the release file share `{ schemaVersion, repository, measurements }`, and the
release reader validates that shape before checking that the repository
fingerprint matches the checkout. A format change must not weaken that
cross-repository guard, overwrite a valid snapshot with an empty one, or make
an older file disappear merely because the reader was upgraded.

## Decision

Keep `.quality.json` as the canonical published format. It remains JSON because
it is portable across languages, supports strict validation, can be replaced
atomically by the existing pull-request publisher, and is easy for a human or
generic tooling to inspect. Do not turn it into an append-only TSV log.

The database is already the append-only history. An append-only checked-in log
would make repository growth unbounded, make escaping and nullable fields part
of every consumer, increase merge conflicts, and work against the existing
daily/category projection. A future archival export can be designed separately;
it should not share the release snapshot path.

The next file format is schema version 2 and uses dictionaries plus fixed rows:

```json
{
  "schemaVersion": 2,
  "repository": "<sha256-origin-fingerprint>",
  "reportVersion": 1,
  "categories": ["security", "ux"],
  "coverage": ["broad", "partial", "unavailable", "not-applicable"],
  "confidence": ["low", "medium", "high"],
  "measurements": [
    ["2026-09-21T12:34:56.000Z", 0, 82, 5, 0, 2, 120, 120]
  ]
}
```

Each row is, in order:

`[assessedAt, categoryIndex, score, worstSeverity, coverageIndex, confidenceIndex, scannedFiles, totalFiles]`

`score` remains nullable. The dictionaries are sorted and de-duplicated by the
writer. Schema version 2 owns the row order, so adding or reinterpreting a
column requires a new version and an explicit migration rather than silently
changing the meaning of old rows. ISO timestamps are retained so freshness and
UTC history keep their current precision; the format does not reduce dates to
midnight merely to save a few bytes.

The `repository` value stays as an opaque origin fingerprint. It is not a
repository ID or raw URL, and it costs one value per file rather than one value
per row. The release reader must be able to reject a `.quality.json` copied
from another repository or fork; file location alone is not provenance. Any
future removal would need a different integrity mechanism and is outside this
redesign.

The persisted v2 row omits `measurementId`. The normalized in-memory record
may still expose a transient tie key: for v2 it is a deterministic digest of
the canonical row, while v1 keeps its supplied ID during normalization. This
preserves deterministic same-timestamp selection without writing an opaque run
identifier into the published file. Database and federation records retain
their existing provenance and wire fields in this change.

## Compatibility and migration

Add one format adapter with strict schemas and a single normalized internal
shape. It must:

1. Parse current v1 JSON and v2 JSON.
2. Recognize the historical `quality-snapshot.json` filename as an explicit
   legacy input when it is found, without treating arbitrary JSON or TSV as a
   quality file.
3. Convert v1 rows to the normalized shape, then serialize only v2.
4. Reject malformed data, unknown future schema versions, invalid dictionary
   indexes, duplicate daily/category winners, future timestamps, mismatched
   repository fingerprints, and files over the existing 4 MiB cap.
5. Preserve numeric-only export rules; summaries, paths, app names, raw agent
   IDs and private evidence never enter either version.

`readReleaseQuality` remains read-only: upgrading the server makes old files
readable but does not mutate a managed checkout during a GET. The publisher
always emits canonical v2 bytes. A dedicated explicit migration operation
should use the same temporary worktree, scoped commit, pull request and
merge-on-green path as normal publication so a project with only an old file
can be upgraded without inventing a new measurement or modifying the live
checkout. Unknown/future formats remain untouched and are reported as
unsupported rather than overwritten.

The file adapter is deliberately separate from the federation wire adapter.
`PORTOS_SCHEMA_VERSIONS.appQuality` and the existing v1 peer payload remain
unchanged in this first step, so a file-format upgrade does not make an older
peer silently lose quality data. The shared normalized records and privacy
checks should be reused by both adapters. A future wire-format change must
bump the per-category version and retain the same fail-closed behavior.

No `scripts/migrations/` entry is needed: those migrations own installed
`data/` paths, while this is a generated repository artifact. The explicit file
migration and its fixture tests are the compatibility mechanism for projects
that already carry a snapshot.

## Retention and publishing invariants

- Keep the current 30-day lookback and one record per UTC day/category.
- Sort v2 rows canonically by timestamp and category index before serialization,
  so equivalent data produces byte-identical output across installs.
- Keep the empty-snapshot protection, 4 MiB read cap, per-checkout publish
  queue, scoped `.quality.json` commit, and merge-on-green PR behavior.
- Treat a v1-to-v2 rewrite as a meaningful migration even when scores did not
  change, but do not create another PR when the normalized v2 bytes already
  exist on the default or snapshot branch.
- Keep the database's immutable per-run rows and existing history semantics;
  the compact file is only a portable recent projection.

## Implementation slices

1. Add the v1/v2 schemas, normalization, deterministic tie-key derivation and
   canonical v2 serializer in the quality snapshot format boundary.
2. Refactor release reads and the publisher to consume the adapter, write v2,
   and distinguish `no-changes`, `unsupported-format`, and migration outcomes.
3. Add the explicit migration entry point for managed projects and PortOS's
   own snapshot command, reusing the existing safe PR workflow.
4. Update the federation decision and app-quality documentation to distinguish
   the v1 wire payload from the v2 checked-in file.

## Verification

- Golden fixtures prove v1 and v2 normalize to the same records and that a
  v1/legacy-file migration is idempotent.
- Round-trip tests prove dictionary indexes, nullable scores, timestamps,
  category ordering and deterministic tie selection.
- Reader tests cover repository mismatch, future evidence, malformed rows,
  unknown versions, oversize files and privacy restrictions.
- Publisher tests prove an old file is upgraded through the isolated PR path,
  an empty database never erases it, equivalent v2 data does not create a
  duplicate PR, and the live checkout/index remains untouched.
- Federation tests prove the peer v1 payload and schema version remain
  unchanged while release files use the new adapter.
- A fixture with the current 30-day/category maximum proves the file remains
  bounded as categories are added and the serialized form is materially smaller
  than v1.

## Out of scope

- Changing the PostgreSQL retention policy or deleting historical measurements.
- Replacing the quality snapshot with TSV, CSV, NDJSON, SQLite, or another
  append-only artifact.
- Removing the repository-origin fingerprint without an equivalent integrity
  boundary.
- Adding new quality categories, changing scoring/freshness rules, or exposing
  audit prose in the repository file.
