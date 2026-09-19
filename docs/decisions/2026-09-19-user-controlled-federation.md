# ADR: Federation Between User-Controlled Machines

- **Date:** 2026-09-19
- **Status:** Accepted
- **Related:** #7664; [Privacy Center storage](./2026-08-08-privacy-records-machine-local.md); [storage contracts](../STORAGE.md)
- **Amends:** the blanket personal-data prohibition in `AGENTS.md`, PRD NR-4, and the scope interpretation of the Privacy Center ADR.

## Context

PortOS federation lets one user carry their records across machines they
own/control on their private network. Brain already replicates personal ideas,
projects, journals, and threads through its delta log and reconciliation
snapshots. A requirement that all personal records remain on one machine
contradicts that capability.

The earlier Privacy Center decision was generalized into a prohibition on all
PII and private records crossing any federation channel. That wording blocked
assigned-issue ingestion into Brain threads in #7664 even though the requested
destination was the user's own machines. The owner's clarification establishes
the audience, rather than the mere presence of personal content, as the relevant
boundary.

## Decision

1. **The user may sync their own records between machines they own/control.**
   Personal names, private project titles, and tracker references do not make
   such a record ineligible for an established record-sync channel. Brain
   threads use the same channel as other Brain entities, including its delta,
   snapshot, tombstone, and compatibility behavior.
2. **Use the configured channel and its controls.** Preserve peer enablement,
   category selection, direction controls, and wire contracts where implemented.
   This decision does not claim that every transport cryptographically proves
   common ownership. The user configures their private network and peers;
   an inbound announcement or reachable host does not establish permission to
   send records to another person. Optional authentication remains optional;
   this clarification adds no password or HTTPS prerequisite to Brain sync.
3. **Credentials and machine-local configuration stay local.** Forge auth,
   JIRA credentials, encryption keys, execution endpoints, and source-selection
   or scheduling settings are not thread data. Assigned-item ingestion must
   keep those settings local while allowing the resulting thread record to
   sync. Enabling ingestion is an explicit user choice; it makes no AI calls.
4. **Other audiences retain their own contracts.** Non-self peers, guest chat,
   public worlds, and external services are not implicitly authorized by this
   decision. Their admission and sharing controls still apply. Status and
   capability payloads keep their existing bounded shapes; they are not record
   export endpoints. Published code, tests, logs, issues, and PRs must still
   exclude observations of live private data.
5. **Permission to sync is distinct from implemented support.** This decision
   adds no record kind, category, endpoint, migration, or background job. Stores
   that are currently local-only remain so. A future change to one must define
   identity, merge/deletion behavior, compatibility, and configuration ownership
   and update its guards accordingly. Personal content alone is not a veto;
   a documentation edit alone is not an implementation of that contract.

## Application to Brain threads

Phases 1–3 of #7664 already provide thread storage, refs, the API, UI, search,
and attach actions. The remaining ingestion phase may create records containing
tracker titles, cached ref labels, and source identity through that existing
Brain store. It must preserve human edits and tombstones, distinguish a failed
tracker query from an empty result, and never infer that an issue is closed
merely because it disappeared from an assigned/open query.

This documentation change resolves the policy conflict. It does not implement
Phase 4's ingestion, scheduler reconciliation, or settings UI, and does not
change the runtime behavior of Brain or any currently local-only store.
