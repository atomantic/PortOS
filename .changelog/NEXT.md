# Unreleased Changes

## Added

- **[versioning-diff-view-per-stage-persist-last-n] Pipeline text stages now keep a version history.** Each regenerate snapshots the prior draft (up to five back) and a new "History" button on the Idea / Prose / Comic Script / Teleplay editors opens a side-by-side word diff against the current version with one-click restore.

## Changed

- **[cover-prose-input-idea-input-in-canonusage-corpus] Universe canon cross-reference test suite now pins every stage the per-issue search reads** — a regression that silently drops a stage from the search now fails the test suite immediately.
- **[extract-shared-requiretoolkit-helper] Internal: consolidated three duplicated AI toolkit accessors into one shared module.** No behavior change; cuts ~30 lines and makes future toolkit-state changes one-touch.

## Fixed

- **[feeds-ssrf-ipv6-bracket-hostname-gap] RSS feed subscriptions now reliably reject IPv6 loopback, link-local, and unique-local addresses** — previously the loopback `http://[::1]/feed` case was blocked only incidentally by DNS errors; subscribing to feeds at literal private IPv6 addresses is now refused outright, including IPv4-mapped variants like `[::ffff:192.168.1.1]`.

## Removed
