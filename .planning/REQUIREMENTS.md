# Requirements: PortOS Next Actions Batch

**Defined:** 2026-02-26
**Core Value:** Ship the five planned next actions that transform PortOS from powerful but siloed features into a connected, protected, and searchable system.

## v1 Requirements

Requirements for this milestone batch. Each maps to roadmap phases.

### Genome Cleanup

- [x] **GEN-01**: Route comments updated from `/api/digital-twin/genome/` to `/api/meatspace/genome/`
- [x] **GEN-02**: IdentityTab Genome card removed or redirected to `/meatspace/genome`
- [x] **GEN-03**: genome.js data paths verified to read from correct directory

### Backup

- [x] **BAK-01**: Incremental rsync backup copies changed files from `./data/` to configurable external drive path
- [x] **BAK-02**: SHA-256 manifest tracks file integrity across backups
- [x] **BAK-03**: Daily backup runs via existing scheduler with configurable interval
- [x] **BAK-04**: Dashboard widget shows last backup time, next scheduled, health status (green/yellow/red)
- [x] **BAK-05**: One-click manual backup trigger from dashboard
- [x] **BAK-06**: Restore from named snapshot with dry-run mode showing what would change
- [x] **BAK-07**: Selective directory restore (e.g., only `data/brain/` without touching other dirs)

### Apple Health

- [x] **HLT-01**: POST `/api/health/ingest` accepts Health Auto Export JSON, validates with Zod, deduplicates by metric+timestamp
- [x] **HLT-02**: Health data persists to day-partitioned `data/health/YYYY-MM-DD.json` files
- [x] **HLT-03**: Bulk XML import streams Apple Health export (500MB+) without OOM via SAX parser
- [x] **HLT-04**: XML import reports progress via WebSocket during processing
- [x] **HLT-05**: MeatSpace dashboard cards for steps, heart rate, sleep, HRV trends
- [x] **HLT-06**: Correlate Apple Health data with existing MeatSpace data (alcohol vs HRV, activity vs blood work)

### Cross-Insights

- [x] **INS-01**: Rule-based genome-to-health correlations using curated 117 markers against actual blood/body data
- [x] **INS-02**: LLM-generated taste-to-identity theme analysis connecting preferences to identity patterns
- [ ] **INS-03**: Insights dashboard UI with confidence levels, source attribution, and domain grouping
- [x] **INS-04**: LLM narrative summaries of cross-domain patterns refreshable on demand

### Unified Search

- [ ] **SRC-01**: Cmd+K / Ctrl+K opens search overlay from any page
- [ ] **SRC-02**: Server-side `/api/search` endpoint fans out keyword queries to existing service search functions
- [ ] **SRC-03**: Results categorized by source (Brain, Memory, Apps, History, Health, etc.) with icons and snippets
- [ ] **SRC-04**: Click result navigates to deep-linked location (specific brain capture, agent run, health entry, etc.)

## v2 Requirements

Deferred to future milestone. Tracked but not in current roadmap.

### Search Enhancements

- **SRC-05**: Semantic/vector search layered on top of keyword search using existing BM25+vector infrastructure
- **SRC-06**: Recent searches and search history

### Backup Enhancements

- **BAK-08**: Rsync to NAS/network target
- **BAK-09**: Backup encryption for sensitive data
- **BAK-10**: Retention policy with N daily + N weekly snapshot pruning

### Health Enhancements

- **HLT-07**: Time-series charts with configurable date ranges for Apple Health metrics
- **HLT-08**: Workout GPS route visualization

### Insights Enhancements

- **INS-05**: Automated insight regeneration when source data changes (EventEmitter-driven cache invalidation)
- **INS-06**: Personality-to-goals insights connecting behavioral patterns to goal success/stall rates

## Out of Scope

| Feature | Reason |
|---------|--------|
| Cloud backup (S3, GCS) | Local external drive is sufficient; no cloud dependency |
| HealthKit direct API | Requires native iOS app; Health Auto Export app provides the bridge |
| Causal genome claims | Insights show correlations with confidence, never claim causation |
| Client-side search indexing | Data lives server-side; server fan-out is simpler and consistent |
| Semantic search in Cmd+K v1 | Keyword-first ships faster; semantic layers on later via existing infra |
| Dashboard drag-and-drop | Tier 4 feature, not in this batch |
| Push notifications (M47) | Deferred to next batch |

## Traceability

Which phases cover which requirements. Updated during roadmap creation.

| Requirement | Phase | Status |
|-------------|-------|--------|
| GEN-01 | Phase 1 | Complete |
| GEN-02 | Phase 1 | Complete |
| GEN-03 | Phase 1 | Complete |
| BAK-01 | Phase 2 | Complete |
| BAK-02 | Phase 2 | Complete |
| BAK-03 | Phase 2 | Complete |
| BAK-04 | Phase 2 | Complete |
| BAK-05 | Phase 2 | Complete |
| BAK-06 | Phase 2 | Complete |
| BAK-07 | Phase 2 | Complete |
| HLT-01 | Phase 3 | Complete |
| HLT-02 | Phase 3 | Complete |
| HLT-03 | Phase 3 | Complete |
| HLT-04 | Phase 3 | Complete |
| HLT-05 | Phase 3 | Complete |
| HLT-06 | Phase 3 | Complete |
| INS-01 | Phase 4 | Complete |
| INS-02 | Phase 4 | Complete |
| INS-03 | Phase 4 | Pending |
| INS-04 | Phase 4 | Complete |
| SRC-01 | Phase 5 | Pending |
| SRC-02 | Phase 5 | Pending |
| SRC-03 | Phase 5 | Pending |
| SRC-04 | Phase 5 | Pending |

**Coverage:**
- v1 requirements: 24 total
- Mapped to phases: 24
- Unmapped: 0 ✓

---
*Requirements defined: 2026-02-26*
*Last updated: 2026-02-26 after initial definition*
