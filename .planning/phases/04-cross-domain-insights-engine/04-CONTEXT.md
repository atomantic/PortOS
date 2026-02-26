# Phase 4: Cross-Domain Insights Engine - Context

**Gathered:** 2026-02-26
**Status:** Ready for planning

<domain>
## Phase Boundary

PortOS surfaces actionable cross-domain patterns by correlating genome markers with health data and taste preferences with identity themes. This phase builds the insights engine and dashboard — it does NOT add new data import capabilities or modify existing genome/health pipelines from prior phases.

</domain>

<decisions>
## Implementation Decisions

### Correlation Display
- Card-based layout grouped by health domain (Cardiovascular, Metabolism, Pharmacogenomics, Cancer Risk, Nutrigenomics, etc.)
- Each card shows: genome variant + actual health value + correlation strength
- Color-coded confidence badges: green (strong evidence), yellow (moderate), red (weak/preliminary) — hover for study source details
- Expandable provenance section per card (collapsed by default): study name, publication year, database source (ClinVar, PharmGKB, etc.)
- 117 curated markers grouped by clinical category into card groups

### Taste-Identity Themes
- Theme cards with narrative: title (e.g., "Comfort-Seeking Explorer"), short narrative paragraph, list of supporting preferences
- All available preference data feeds the analysis (music, food, aesthetics, media, travel, etc.) — LLM finds patterns across whatever's available
- Supporting evidence list under each theme card (collapsible): which preferences contributed and why they map to this theme
- Analytical and neutral tone — third-person, research-flavored: "The data indicates a pattern of..."

### Insights Dashboard
- Tabbed by domain: Genome-Health, Taste-Identity, Cross-Domain Patterns — deep-linkable routes (/insights/genome-health, etc.)
- Landing view shows domain summary cards: key stat, top insight, confidence indicator per domain — click to enter domain tab
- Inline source tags on each card/insight: "23andMe", "Apple Health", "Spotify", etc.
- Gentle empty states for domains with no data: "No health data imported yet" with link to relevant import

### Narrative Summaries
- 2-3 paragraph summaries of cross-domain patterns — concise but substantive, readable in under a minute
- Refresh button with diff: re-analysis shows what changed since last generation (new patterns, confidence changes)
- Analytical with personal framing tone: neutral, evidence-based but framed around "your data shows..."
- Cross-domain narratives live in the dedicated Cross-Domain Patterns tab

### Claude's Discretion
- Exact card dimensions, spacing, and responsive breakpoints
- LLM prompt engineering for theme analysis and narrative generation
- Caching strategy for LLM-generated content
- Loading states and skeleton designs during LLM processing
- How to handle edge cases where genome and health data have no meaningful correlation

</decisions>

<specifics>
## Specific Ideas

- Confidence badges should be consistent across all insight types (genome-health and taste-identity)
- The diff on narrative refresh should highlight what's new, not just replace content — user should see how their insights evolve as more data comes in
- Provenance is non-negotiable: every genome-to-health claim must trace back to a specific study or database

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---

*Phase: 04-cross-domain-insights-engine*
*Context gathered: 2026-02-26*
