# Digital Twin Personality Enhancement

Quantitative personality modeling and prediction system that accurately embodies a human's values, decision patterns, and communication style.

## Vision

Transform the Digital Twin from a document capture system into a quantitative personality modeling and prediction system.

## Architecture

- **Digital Twin Service** (`server/services/digital-twin.js`, with logic split across ~25 `digital-twin-*.js` modules): Trait analysis, confidence scoring, gap recommendations
- **Digital Twin Routes** (`server/routes/digital-twin.js`): REST API endpoints
- **Digital Twin Validation** (`server/lib/digitalTwinValidation.js`): Zod schemas for trait data

## Features

### Phase 1: Quantitative Personality Modeling (Complete)

**Big Five Trait Scoring**
- Quantified OCEAN scores (Openness, Conscientiousness, Extraversion, Agreeableness, Neuroticism)
- Infer scores from existing documents using LLM analysis
- Allow manual override/adjustment
- Store in `meta.json` under `traits.bigFive`

**Values Hierarchy**
- Extract explicit values from VALUES.md and NON_NEGOTIABLES.md
- Create ranked values list with conflict resolution rules
- Store in `meta.json` under `traits.valuesHierarchy`

**Communication Fingerprint**
- Quantify writing style: formality (1-10), verbosity (1-10), emoji usage, sentence length avg
- Extract from WRITING_STYLE.md and writing samples
- Store in `meta.json` under `traits.communicationProfile`

### Phase 2: Personality Confidence Scoring (Complete)

**Coverage Metrics**
- For each Big Five dimension: evidence count from documents
- For each value: supporting document count + specificity score
- For communication: sample diversity, consistency across samples

**Confidence Algorithm**
```
confidence(aspect) = min(1.0,
  (evidence_count / required_evidence) *
  (consistency_score) *
  (recency_weight)
)
```

**Gap Recommendations**
- Identify lowest-confidence aspects
- Generate specific questions to fill gaps
- Prioritize enrichment categories by confidence gap

### Phase 4: External Data Integration (Complete)

Import from external sources to reduce manual input:
- Goodreads CSV import for reading preferences
- Spotify/Last.fm for music profile
- Calendar pattern analysis for routines

## Data Structure

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

## UI Components

- `PersonalityMap.jsx` - Radar chart of Big Five with confidence coloring
- `ConfidenceGauge.jsx` - Per-dimension confidence indicator
- `GapRecommendations.jsx` - Prioritized enrichment suggestions

## API Endpoints

| Route | Description |
|-------|-------------|
| GET /api/digital-twin/traits | Get all trait scores |
| POST /api/digital-twin/traits/analyze | Analyze documents to extract traits |
| PUT /api/digital-twin/traits | Manual override trait scores |
| GET /api/digital-twin/confidence | Get confidence scores |
| POST /api/digital-twin/confidence/calculate | Recalculate confidence |
| GET /api/digital-twin/gaps | Get gap recommendations |

## Planned Phases

### Phase 3: Behavioral Feedback Loop
- Response validation: "sounds like me" / "not quite me" ratings
- Feedback analysis and document improvement suggestions
- Adaptive document weighting based on feedback patterns

### Phase 5: Multi-Modal Personality Capture
- Voice analysis for speech patterns
- Video interview for facial expressions and gestures
- Comparison of spoken vs written style

### Phase 6: Advanced Behavioral Testing
- Complex multi-turn conversation scenarios — **done**: the Test tab's multi-turn suite (`MULTI_TURN_SUITE.md`) plays each scenario's user turns in order (the twin sees its own prior replies) and grades whether the twin stayed consistent / partial / inconsistent across the whole conversation — not contradicting earlier turns, caving to repeated pushback, or forgetting a stated constraint
- Ethical dilemma tests aligned with stated values — **done**: the Test tab's values-alignment suite poses dilemmas and grades each answer against the user's ranked values hierarchy
- Quantitative scoring of communication style match
- Adversarial testing of boundaries — **done**: the Test tab's adversarial-boundary suite (`ADVERSARIAL_BOUNDARY_SUITE.md`) tries to manipulate the embodied twin (authority pressure, flattery, guilt, incremental escalation, harmful reframing) into crossing a stated boundary, and grades each response held / partial / breached

### Phase 7: Twin Personas & Context Switching
- Named personas (Professional, Casual, Family, Creative)
- Blending rules for trait variation per context
- Per-persona testing — **done**: the Test tab can run the behavioral and values-alignment suites *as* a selected persona (or the base twin), and each run-history entry records which persona it embodied

## Success Metrics

| Metric | Current | Target |
|--------|---------|--------|
| Behavioral test pass rate | ~70% | >90% |
| Enrichment category coverage | Manual | Confidence-guided |
| User feedback: "sounds like me" | N/A | >85% |
| Time to usable twin | Hours | <30 min |
| Trait confidence coverage | 0% | >80% across all dimensions |

## Related Features

- [Soul System](./soul-system.md) - Document-based identity management
- [Chief of Staff](./chief-of-staff.md) - Uses twin context in agent prompts
