# Numeric PortOS quality federation

PortOS audits may run on several federated installs. The quality panel and its
history combine measurements for the baseline PortOS app across this install
and directly registered full-sync peers. Other managed apps remain local.

The newest assessment per category wins (run hash breaks timestamp ties), then
the existing equal-weight category mean applies: broad coverage, medium/high
confidence and no older than 30 days. Partial or unavailable newer assessments
supersede older evidence without manufacturing a qualifying score. Repeated
reads and repeated runs do not give a machine extra weight. UTC history uses
only evidence available by each day's end, with the same freshness rules.

Only peers with full sync enabled, sync not disabled, and an outbound-approved
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
each analysis install as a full-sync peer to obtain the same complete view.

The existing `app_quality_measurements` DB-primary store is unchanged and covered
by normal PostgreSQL backup. No migration, seed, background job, persistent peer
cache or new record-sync category is needed. This numeric projection does not
relax the machine-local privacy rule for source evidence or other records.
