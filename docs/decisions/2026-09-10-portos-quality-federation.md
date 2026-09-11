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
