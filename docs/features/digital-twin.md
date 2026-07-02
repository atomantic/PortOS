# Digital Twin Personality Enhancement

Quantitative personality modeling and prediction on top of the [Soul System](./soul-system.md)'s document store: trait scoring, confidence measurement, behavioral testing, feedback-driven weighting, and personas.

This doc covers the quantitative-modeling layer. The document workflow (Documents/Enrich/Export tabs, soul markdown files) is documented in [Soul System](./soul-system.md); the broader identity architecture (genome, chronotype, taste, goals) in [Unified Identity System](./identity-system.md).

## Architecture

- **Digital Twin Service** (`server/services/digital-twin.js`, with logic split across ~20 `digital-twin-*.js` modules plus `feedbackLoop.js`): trait analysis, confidence scoring, gap recommendations, testing suites, personas, imports
- **Digital Twin Routes** (`server/routes/digital-twin.js`): REST API under `/api/digital-twin/*`
- **Digital Twin Validation** (`server/lib/digitalTwinValidation.js`): Zod schemas for trait data

## Quantitative Personality Modeling

**Big Five Trait Scoring** — quantified OCEAN scores (Openness, Conscientiousness, Extraversion, Agreeableness, Neuroticism), inferred from existing soul documents via LLM analysis, with manual override/adjustment. Stored in `meta.json` under `traits.bigFive`.

**Values Hierarchy** — explicit values extracted from VALUES.md and NON_NEGOTIABLES.md into a ranked list. Stored under `traits.valuesHierarchy`.

**Communication Fingerprint** — quantified writing style (formality, verbosity, sentence length, emoji usage, tone), extracted from WRITING_STYLE.md and writing samples. Stored under `traits.communicationProfile`.

```javascript
traits: {
  bigFive: { O: 0.75, C: 0.82, E: 0.45, A: 0.68, N: 0.32 },
  valuesHierarchy: ["authenticity", "growth", "family", ...],
  communicationProfile: {
    formality: 6,
    verbosity: 4,
    avgSentenceLength: 18,
    emojiUsage: "rare",
    preferredTone: "direct-but-warm"
  },
  lastAnalyzed: "2026-01-21T..."
}
```

## Confidence Scoring & Gap Recommendations

Per-dimension confidence is computed either by an AI pass (`calculateConfidence`) or a deterministic local fallback (`calculateLocalConfidence` in `server/services/digital-twin-analysis.js`) that scores each Big Five dimension plus communication from document evidence. Results persist at `meta.confidence`.

Gap recommendations identify the lowest-confidence aspects, generate specific questions to fill them, and prioritize enrichment categories by confidence gap. They regenerate after enrichment answers and data imports.

## Behavioral Feedback Loop

`server/services/feedbackLoop.js` captures "sounds like me" / "doesn't sound like me" validations on twin responses, tracks feedback patterns, and adjusts per-document weights used in confidence scoring and context assembly. Feedback persists in `feedback.json` (peer-synced). Routes: `POST /feedback`, `GET /feedback/stats`, `POST /feedback/recalculate`, `GET /feedback/recent`.

## External Data Import

`server/services/digital-twin-import.js` reduces manual input by importing:

- **Goodreads** CSV export (reading preferences)
- **Spotify** extended streaming history JSON (music profile)
- **Letterboxd** film export
- **iCal** calendar files — event categorization and recurring-pattern analysis (routines)

Routes: `GET /import/sources`, `POST /import/analyze`, `POST /import/save`.

## Transcript & Image Analysis

Multi-modal capture works on pasted/uploaded artifacts — there is no live audio or video capture infrastructure:

- **Interview analysis** (`POST /interview/analyze`) — extracts traits from a pasted conversation transcript
- **Spoken vs. written style comparison** (`POST /style/spoken-written`, `digital-twin-style-comparison.js`) — compares a pasted speech transcript against written samples; the output is qualitative (spoken/written profiles, differences, a suggested communication profile), not a numeric match score
- **Image identity** (`POST /identity/image`, `digital-twin-image-identity.js`) — analyzes an uploaded image for identity/visual-spec content

## Behavioral Testing Suites

All run from the Test tab, graded by an LLM scorer with pass/partial/fail verdicts (`parseScorerVerdict`), with per-suite run history:

- **Behavioral tests** — the base suite plus AI-generated dynamic tests (see [Soul System](./soul-system.md))
- **Multi-turn conversation suite** (`MULTI_TURN_SUITE.md`, `digital-twin-multi-turn-testing.js`) — plays each scenario's user turns in order (the twin sees its own prior replies) and grades whether the twin stayed consistent across the whole conversation: not contradicting earlier turns, caving to repeated pushback, or forgetting a stated constraint
- **Values-alignment suite** (`VALUES_ALIGNMENT_SUITE.md`, `digital-twin-values-testing.js`) — poses ethical dilemmas and grades each answer against the ranked values hierarchy
- **Adversarial boundary suite** (`ADVERSARIAL_BOUNDARY_SUITE.md`, `digital-twin-adversarial-testing.js`) — tries to manipulate the embodied twin (authority pressure, flattery, guilt, incremental escalation, harmful reframing) into crossing a stated boundary; grades held / partial / breached

Suite spec documents ship in `data.reference/digital-twin/`.

## Personas & Context Switching

`server/services/digital-twin-personas.js` provides named personas (e.g. Professional, Casual, Family) with full CRUD, stored in `meta.personas`. One persona is active at a time (`meta.settings.activePersonaId`); its `traitAdjustments` blend over the base twin's quantitative traits to produce a per-context communication calibration. All four Test-tab suites (behavioral, values-alignment, adversarial-boundary, multi-turn) can execute *as* a selected persona, and each run-history entry records which persona it embodied.

## UI Components

Page: `client/src/pages/DigitalTwin.jsx`. Quantitative-layer components in `client/src/components/digital-twin/`:

- `PersonalityMap.jsx` — radar chart of Big Five with confidence coloring
- `ConfidenceGauge.jsx` — per-dimension confidence indicator
- `GapRecommendations.jsx` — prioritized enrichment suggestions
- `InterviewAnalysisCard.jsx`, `PersonaBadge.jsx`, `tabs/AdversarialBoundaryPanel.jsx`, and the tab panels under `tabs/`

## API Endpoints (quantitative layer)

| Route | Description |
|-------|-------------|
| GET /api/digital-twin/traits | Get all trait scores |
| POST /api/digital-twin/traits/analyze | Analyze documents to extract traits |
| PUT /api/digital-twin/traits | Manual override trait scores |
| GET /api/digital-twin/confidence | Get confidence scores |
| POST /api/digital-twin/confidence/calculate | Recalculate confidence |
| GET /api/digital-twin/gaps | Get gap recommendations |
| POST /api/digital-twin/feedback | Submit "sounds like me" validation |
| GET/POST /api/digital-twin/feedback/* | Feedback stats, recalculate weights, recent |
| GET/POST /api/digital-twin/{values,adversarial,multi-turn}-tests[/run,/history] | Testing suites |
| GET/POST/PUT/DELETE /api/digital-twin/personas[/:id,/active] | Persona CRUD + active selection |
| GET/POST /api/digital-twin/import/* | External data import |
| POST /api/digital-twin/interview/analyze | Transcript trait extraction |
| POST /api/digital-twin/style/spoken-written | Spoken vs written comparison |
| POST /api/digital-twin/identity/image[/save] | Image identity analysis |
| GET/POST/DELETE /api/digital-twin/snapshots[/:id,/compare] | Twin snapshots and comparison |

The document/test/enrich/export endpoints shared with the document workflow are listed in [Soul System](./soul-system.md).

## Not Built

Kept as an honest record of the original roadmap's unshipped ideas:

- Live voice-audio analysis and video-interview capture (only pasted transcripts and uploaded images are supported)
- A numeric communication-style match score (style comparison is qualitative)
- Multi-persona blending (one active persona overlays the base twin)
- Last.fm import (music import is Spotify-only)

## Related Features

- [Soul System](./soul-system.md) — document-based identity management (the document workflow this layer builds on)
- [Unified Identity System](./identity-system.md) — genome/chronotype/taste/goals identity architecture
- [Chief of Staff](./chief-of-staff.md) — uses twin context in agent prompts
