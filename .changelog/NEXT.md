# Unreleased Changes

## Added

- **[versioning-diff-view-per-stage-persist-last-n] Pipeline text stages now keep a version history.** Each regenerate snapshots the prior draft (up to five back) and a new "History" button on the Idea / Prose / Comic Script / Teleplay editors opens a side-by-side word diff against the current version with one-click restore.

## Changed

- **[cover-prose-input-idea-input-in-canonusage-corpus] Universe canon cross-reference test suite now pins every stage the per-issue search reads** — a regression that silently drops a stage from the search now fails the test suite immediately.
- **[extract-shared-requiretoolkit-helper] Internal: consolidated three duplicated AI toolkit accessors into one shared module.** No behavior change; cuts ~30 lines and makes future toolkit-state changes one-touch.
- **[codex5-bundle-lazy-routes] Dashboard widgets load on demand.** A dashboard layout now only downloads the widgets it actually uses — the first paint of a slimmed-down layout no longer drags in every widget in the registry, and slow widgets render their own placeholder while loading instead of blocking sibling cells. Also adds an `npm run build:analyze` script for inspecting bundle composition during development.
- **[strip-stage-runhistory-from-list-payloads] Pipeline list views stay lean as version history grows.** The sidebar's recent-issues list and the per-series issue list no longer ship each stage's full draft history on every read — the History button on an issue's detail page still shows the full set, but list responses can no longer balloon to many megabytes once a series has many issues with deep histories.

## Fixed

- **[universebuilder-collection-hook-flaky-batch-enrich] Universe Builder batch-enrich test no longer flakes under full-suite load** — internal test stability fix; production behavior unchanged.
- **[feeds-ssrf-ipv6-bracket-hostname-gap] RSS feed subscriptions now reliably reject IPv6 loopback, link-local, and unique-local addresses** — previously the loopback `http://[::1]/feed` case was blocked only incidentally by DNS errors; subscribing to feeds at literal private IPv6 addresses is now refused outright, including IPv4-mapped variants like `[::ffff:192.168.1.1]`.
- **[feeds-ssrf-aaaa-record-blindness] RSS feed subscriptions now check the IPv6 address family too** — a hostname that pointed to a public IPv4 address but a private IPv6 one used to slip past the SSRF guard because only the IPv4 records were checked; now both families are resolved together, any private address in either family rejects the feed, and IPv6-only hostnames (which used to fail outright) are accepted when they resolve to a public address.
- **[legacy-series-canon-orphan-universe-leak-on-throw] Retrying a failed peer-share import no longer leaves empty "(auto-migrated)" universes behind** — when a transient disk error interrupted importing a peer's series, each retry used to mint a fresh empty universe; the importer now reuses the same one across retries so the import either lands cleanly or is harmless to retry.
- **[ansistrip-osc-alternative-unreachable] TUI output no longer leaks window-title and hyperlink escape bodies** — terminal OSC sequences (the ones CLIs use to set window titles or emit clickable links) are now stripped in full instead of leaving fragments like `0;title␇` visible in agent/TUI transcripts, prompt-runner logs, and arc-planner output.

## Removed
