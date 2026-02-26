# Roadmap: PortOS Next Actions Batch

## Overview

This batch transforms PortOS from a collection of powerful but siloed features into a connected, protected, and searchable system. Five phases follow a strict dependency chain: clean up stale genome references (unblocking insights), protect all data with backup (before adding new data writers), ingest Apple Health data (the richest new source), derive cross-domain insights (connecting genome, health, taste, and identity), and finally wire up unified search across everything. Each phase delivers a complete, independently verifiable capability.

## Phases

**Phase Numbering:**
- Integer phases (1, 2, 3): Planned milestone work
- Decimal phases (2.1, 2.2): Urgent insertions (marked with INSERTED)

Decimal phases appear between their surrounding integers in numeric order.

- [ ] **Phase 1: Genome Migration Cleanup** - Fix stale digital-twin genome references so data reads from the correct meatspace location
- [ ] **Phase 2: Data Backup & Recovery** - Incremental rsync backup to external drive with scheduling, dashboard widget, and restore capability
- [ ] **Phase 3: Apple Health Integration** - Ingest Health Auto Export JSON and bulk XML into day-partitioned storage with dashboard cards
- [ ] **Phase 4: Cross-Domain Insights Engine** - Genome-to-health correlations and taste-to-identity themes with confidence levels and source attribution
- [ ] **Phase 5: Unified Search (Cmd+K)** - Keyboard-triggered search overlay with server-side fan-out across all data sources

## Phase Details

### Phase 1: Genome Migration Cleanup
**Goal**: Genome data reads from the correct directory and all stale digital-twin references are eliminated
**Depends on**: Nothing (first phase)
**Requirements**: GEN-01, GEN-02, GEN-03
**Success Criteria** (what must be TRUE):
  1. All genome API route comments reference `/api/meatspace/genome/` (no digital-twin references remain)
  2. IdentityTab no longer shows a Genome card (or it links to `/meatspace/genome` instead of a dead route)
  3. genome.js reads data from `data/meatspace/` paths and returns valid genome data
**Plans**: TBD

Plans:
- [ ] 01-01: TBD

### Phase 2: Data Backup & Recovery
**Goal**: All PortOS data is automatically backed up to an external drive with integrity verification and restore capability
**Depends on**: Nothing (can parallel with Phase 1)
**Requirements**: BAK-01, BAK-02, BAK-03, BAK-04, BAK-05, BAK-06, BAK-07
**Success Criteria** (what must be TRUE):
  1. Running backup copies changed files from `./data/` to the configured external drive path using incremental rsync
  2. A SHA-256 manifest file exists after each backup and can verify file integrity
  3. Backup runs automatically on a daily schedule and can be triggered manually from the dashboard
  4. Dashboard widget displays last backup time, next scheduled time, and health status (green/yellow/red)
  5. User can restore from a named snapshot with dry-run preview, and can selectively restore individual directories
**Plans**: TBD

Plans:
- [ ] 02-01: TBD
- [ ] 02-02: TBD

### Phase 3: Apple Health Integration
**Goal**: Apple Health data flows into PortOS via JSON ingest and bulk XML import, with health metrics visible on the MeatSpace dashboard
**Depends on**: Phase 2 (backup must protect data before adding new data writers)
**Requirements**: HLT-01, HLT-02, HLT-03, HLT-04, HLT-05, HLT-06
**Success Criteria** (what must be TRUE):
  1. POST `/api/health/ingest` accepts Health Auto Export JSON, validates it, deduplicates by metric+timestamp, and persists to day-partitioned files
  2. Bulk Apple Health XML export (500MB+) imports without OOM via streaming SAX parser, with progress reported via WebSocket
  3. MeatSpace dashboard shows cards for steps, heart rate, sleep, and HRV trends from ingested data
  4. Apple Health data correlates with existing MeatSpace data (alcohol vs HRV, activity vs blood work)
**Plans**: TBD

Plans:
- [ ] 03-01: TBD
- [ ] 03-02: TBD

### Phase 4: Cross-Domain Insights Engine
**Goal**: PortOS surfaces actionable cross-domain patterns by correlating genome markers with health data and taste preferences with identity themes
**Depends on**: Phase 1 (clean genome paths), Phase 3 (health data available for correlation)
**Requirements**: INS-01, INS-02, INS-03, INS-04
**Success Criteria** (what must be TRUE):
  1. Genome-to-health correlations display against actual blood/body data using the curated 117 markers, with provenance citations
  2. LLM-generated taste-to-identity theme analysis connects user preferences to identity patterns
  3. Insights dashboard groups results by domain with confidence levels and source attribution
  4. LLM narrative summaries of cross-domain patterns can be refreshed on demand
**Plans**: TBD

Plans:
- [ ] 04-01: TBD
- [ ] 04-02: TBD

### Phase 5: Unified Search (Cmd+K)
**Goal**: Any piece of information in PortOS is one keystroke away via a global search overlay
**Depends on**: Phases 1-4 (benefits from all data sources existing, but technically only needs server routes)
**Requirements**: SRC-01, SRC-02, SRC-03, SRC-04
**Success Criteria** (what must be TRUE):
  1. Pressing Cmd+K (or Ctrl+K) from any page opens a search overlay
  2. Typing a query returns results from all data sources (Brain, Memory, Apps, History, Health, etc.) via server-side fan-out
  3. Results are categorized by source with icons and text snippets
  4. Clicking a result navigates to the deep-linked location (specific brain capture, agent run, health entry, etc.)
**Plans**: TBD

Plans:
- [ ] 05-01: TBD

## Progress

**Execution Order:**
Phases execute in numeric order: 1 -> 2 -> 3 -> 4 -> 5
Note: Phases 1 and 2 have no dependency on each other and can execute in parallel.

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Genome Migration Cleanup | 0/1 | Not started | - |
| 2. Data Backup & Recovery | 0/2 | Not started | - |
| 3. Apple Health Integration | 0/2 | Not started | - |
| 4. Cross-Domain Insights Engine | 0/2 | Not started | - |
| 5. Unified Search (Cmd+K) | 0/1 | Not started | - |
