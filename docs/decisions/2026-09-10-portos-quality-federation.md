# Numeric app quality federation

PortOS audits may run on several federated installs. The quality panel and its
history combine measurements for matching managed repositories across this install
and directly registered sync peers. Local app IDs, names and paths need not match.

The newest assessment per category wins (run hash breaks timestamp ties), then
the existing equal-weight category mean applies: broad coverage, medium/high
confidence and no older than 30 days. Partial or unavailable newer assessments
supersede older evidence without manufacturing a qualifying score. Repeated
reads and repeated runs do not give a machine extra weight. UTC history uses
only evidence available by each day's end, with the same freshness rules.

Only peers with sync not disabled and an outbound-approved
relationship are queried or served. The receiving endpoint always enforces this
sharing policy, regardless of the legacy strict-pull ramp. The instance-id header
identifies the configured peer; it is not authentication. Optional instance
passwords continue to be sent through the existing peer HTTP client.

The wire contract is versioned in `PORTOS_SCHEMA_VERSIONS.appQuality`. It exports
only validated category enums, numeric scores/severity/inventory counts,
coverage/confidence enums, timestamps and opaque run hashes. It never exports
assessment summaries, transcripts, app paths, raw run IDs or private records.
Only locally recorded measurements are served, so a read cannot recursively fan
out or relay another peer's data. A hash of the normalized Git origin host and
repository name scopes the exchange; raw remote URLs and credentials never
travel. Unknown origins and different forks do not combine. Versions of the same
repository intentionally combine: this is a distributed maintenance assessment,
not a claim that every installed commit has identical code quality.

Reads fetch existing data, never AI work. Each peer has a three-second deadline
and a 4 MiB response cap. At most one row per UTC day/category is transferred,
including a 30-day lookback for history. Old peers (404), unauthorized peers,
incompatible schemas, malformed responses, differing repositories and offline
peers are excluded and counted as unavailable in the UI. Local scores remain
usable. This is read-through aggregation, not durable replication: history and
scores may change with peer availability. It covers direct peers only; configure
each analysis install as an enabled sync peer to obtain the same complete view.

The existing `app_quality_measurements` DB-primary store is unchanged and covered
by normal PostgreSQL backup. No migration, seed, background job, persistent peer
cache or new record-sync category is needed. This numeric projection does not
relax the machine-local privacy rule for source evidence or other records.

## September 11: matching apps and release snapshots

Full-sync was an unintended additional gate: configured selective-sync peers
(including Void) could exchange their selected records but received 403 for
quality. Numeric assessments now follow the enabled outbound relationship and
master sync switch, independently of private record categories. Turning off sync
or disabling/removing the peer stops sharing. The local app must have the same
normalized Git origin; matching a display name alone never exports evidence.
The optional `repository` query is a hash, retaining the v1 response shape and
PortOS default for older clients. Older servers may reject selective peers or
return PortOS for that query; repository validation excludes mismatches.

Before each release, run `npm run quality:snapshot` on the install holding local
PortOS assessments, then include `quality-snapshot.json` in the release commit.
The command reads the existing DB, sanitizes the same numeric projection, and
refuses to replace a snapshot when no evidence is available. It invokes no AI
and includes neither peer contributions nor source narratives. CI publishes the
committed file with the source release; it does not need the private database.

Every matching PortOS checkout reads that file alongside local and peer evidence.
Original assessment dates and the 30-day freshness rule remain intact, so an old
release cannot masquerade as a fresh assessment. Forks with a different origin
ignore the upstream snapshot. Shipped evidence is labeled "Release snapshot"
and is never re-exported as a local run. Full run logs and transcripts remain
machine-local; only numeric run assessments cross instances.

## September 14: managed-app snapshots (`.quality.json`)

The release snapshot above was PortOS-only: every other managed app's numeric
evidence stayed in the database of whichever install ran the audit, so a second
machine that had never audited the app showed no score for it. Managed apps now
get the same shipped-evidence path.

Each app carries an opt-in `publishQualitySnapshot` setting (unset/false = off).
When it is on, every audit that records a measurement for the app rebuilds the
app's numeric snapshot and commits it to `.quality.json` at the app's repo root.
`POST /api/apps/:id/quality-snapshot` does the same on demand and is deliberately
not gated on the toggle — a manual call is explicit intent.

The file IS a snapshot, not a wrapper: the exact `{ schemaVersion, repository,
measurements }` a federation export carries, serialized the same way as PortOS's
own root `quality-snapshot.json`. The filename is generic and PortOS-agnostic on
purpose — it is generated data any tool can read. If PortOS ever needs a config
manifest inside a managed repo, that is a separate, hand-editable file; generated
evidence and configuration do not share one path. **PortOS's own root
`quality-snapshot.json` is unchanged** — same name, same publisher, same reader.

Publishing is conservative. An app with no repo path, a repo path that is not a
git checkout, or a snapshot with zero measurements is skipped, so an empty
snapshot can never overwrite a populated file. A rebuild whose bytes match the
committed file skips git entirely, so an audit that moved nothing leaves no
commit. The commit is scoped with `git commit -- :(literal).quality.json`, so an
automated write can never sweep in whatever the user had staged, and nothing is
ever pushed. The audit-completion hook runs outside the request lifecycle and
swallows every failure: a locked index never fails a completion.

Reading is not gated on the toggle. PortOS reads a `.quality.json` in ANY managed
app's repo as a "Release snapshot" quality source, with exactly the guards the
PortOS snapshot already gets: schema validation, the normalized-origin repository
hash must match, future assessment dates are dropped, the 30-day freshness rule
and original dates still apply, a 4 MiB cap, and the records are labeled
"Release snapshot" and never re-exported as local runs. A checkout of a different
fork ignores the file. The content stays numeric-only — no summaries, paths, run
ids or app names — so committing it to a public repository leaks nothing the
federation wire contract would not already carry.

## September 15: one snapshot file, one publisher

The two sections above left PortOS publishing a root `quality-snapshot.json`
through its own script and reading it through its own branch in `releasePayload`,
beside every managed app's `.quality.json` — same bytes, same schema, same
guards, two names and two code paths kept in step by hand.

PortOS is a managed app with a `repoPath` like any other, so its release snapshot
is now that same `.quality.json` at the checkout root, written by the same
publisher and read by the same reader. The per-app `publishQualitySnapshot`
toggle automates it for PortOS too, and stays **off by default there**: an audit
that commits into the primary checkout on its own is opt-in, since that checkout
is also where CoS worktrees and branches are managed. `npm run quality:snapshot`
remains the explicit release trigger and now commits the file itself.

The rename is a git rename of tracked, derived content — no migration, since
`scripts/migrations/` governs `data/` paths and there is no install state to
carry. A fork that published under the old name resolves one rename conflict;
worst case it regenerates the file from its own database on the next publish.

## September 21: land snapshots through a merge-on-green PR

Committing `.quality.json` on the live checkout left the default branch ahead of
origin, and many managed apps refuse direct pushes to `main`. Publishing now
writes the file in a temporary worktree on `portos/quality-snapshot`, opens a
pull request, and queues the existing merge-on-green sweep (`queuePendingMerge`
on GitHub; GitLab auto-merge when the pipeline succeeds). No review is requested.
The live checkout is not committed, staged, or switched. An unchanged snapshot
still skips git entirely.

## September 22: compact file schema v2

The sections above coupled the checked-in file to the federation object
(`{ schemaVersion, repository, measurements }`). A file-format change would have
forced a peer wire rollout. Those are now two adapters over one normalized
record. `PORTOS_SCHEMA_VERSIONS.appQuality` stays 1, and peers still exchange
the v1 object payload. The checked-in file is schema v2.

v2 keeps the opaque origin fingerprint and replaces per-row objects with sorted
dictionaries plus fixed rows:

`[assessedAt, categoryIndex, score, worstSeverity, coverageIndex, confidenceIndex, scannedFiles, totalFiles]`

`reportVersion` is 1. Category dictionaries list the categories that appear, in
order. Coverage and confidence dictionaries are the full enums in their declared
order. Scores stay nullable. Timestamps stay ISO instants, not midnight dates.
`measurementId` is not stored. While a v1 file still carries that id, release
reads keep it for same-timestamp ordering. v2 reads use a transient digest of
the normalized row. The digest is not written. Database provenance fields are
unchanged.

The canonical artifact stays JSON. An append-only TSV, CSV, or NDJSON log was
rejected: the database is already the immutable history, and a checked-in append
log would be unbounded, harder to validate, and more conflict-prone. The file
remains the bounded release projection: one row per UTC day and category, the
30-day lookback, and the 4 MiB cap. PostgreSQL retention is unchanged. No
`scripts/migrations/` entry is involved; those migrations own `data/` paths.

Readers accept v1 `.quality.json` and, only when that file is absent, the
historical `quality-snapshot.json` filename. A read never mutates the checkout.
Malformed rows, unknown keys, invalid dictionary indexes, duplicate UTC
day/category winners, a mismatched origin fingerprint, and oversize files fail
closed. A future `schemaVersion` is recognized and left unparsed.

`npm run quality:snapshot` writes canonical v2 whenever the database has current
evidence, including when the committed file is still valid v1. It does not
invent rows the database does not have, and it does not replace a non-empty
file when evidence is absent. A future schema, an unrecognized document, a
malformed snapshot, or an oversize file is left untouched and reported as
`unsupported-format`. A second publish whose normalized v2 bytes are already on
the default branch or the snapshot branch does not open another pull request.

`npm run quality:snapshot -- --migrate` converts a v1 file, or the historical
filename, through the same temporary worktree, scoped commit, and
merge-on-green pull request. It uses only rows already in the file. When the
historical filename is the source, the commit also removes it. Unknown future
formats stay in place.
