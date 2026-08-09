# Twin Confidence Analyzer

You are grading how well a person's digital twin is *defined* — not how good a person they are. For each dimension below, judge whether the documents contain enough concrete, first-person evidence for a twin to act like them on that dimension without guessing.

A dimension backed by a single adjective scores low even when the adjective is flattering. A dimension backed by examples, stated rules, and worked-through tradeoffs scores high.

## Twin Content

"""
{{twinContent}}
"""

## Traits Already Extracted

```json
{{currentTraits}}
```

## Dimensions

Score every one of these from 0.0 (nothing usable) to 1.0 (fully specified with examples):

`openness`, `conscientiousness`, `extraversion`, `agreeableness`, `neuroticism`, `values`, `communication`, `decision_making`, `boundaries`, `identity`

Scoring guide:

- **0.0-0.2** — the documents say nothing about it, or only a stray adjective
- **0.3-0.5** — asserted but not demonstrated; no examples, no rules
- **0.6-0.7** — described with at least one concrete example or stated rule
- **0.8-1.0** — described, exemplified, and tested against a tradeoff or edge case

Set `overall` to the mean of the ten dimension scores, rounded to two decimals.

## Gaps

For every dimension scoring below 0.6, emit a gap entry:

- `dimension` — the dimension key
- `confidence` — the same score you gave it
- `evidenceCount` — how many distinct passages you found supporting it (0 if none)
- `requiredEvidence` — how many you would need for a 0.8, at least 1
- `suggestedQuestions` — 1-3 questions whose answers would close the gap, phrased to the person in second person
- `suggestedCategory` — the enrichment category the questions belong to, one of: `core_memories`, `favorite_books`, `favorite_movies`, `music_taste`, `communication`, `decision_making`, `values`, `aesthetics`, `daily_routines`, `career_skills`, `non_negotiables`, `decision_heuristics`, `error_intolerance`, `personality_assessments`

Emit no gap for a dimension scoring 0.6 or above.

## Output Format

Return ONLY a fenced JSON block, no prose before or after. All ten dimension keys must be present:

```json
{
  "overall": 0.0,
  "dimensions": {
    "openness": 0.0,
    "conscientiousness": 0.0,
    "extraversion": 0.0,
    "agreeableness": 0.0,
    "neuroticism": 0.0,
    "values": 0.0,
    "communication": 0.0,
    "decision_making": 0.0,
    "boundaries": 0.0,
    "identity": 0.0
  },
  "gaps": [
    {
      "dimension": "boundaries",
      "confidence": 0.3,
      "evidenceCount": 1,
      "requiredEvidence": 3,
      "suggestedQuestions": ["What request would you always refuse, no matter who asked?"],
      "suggestedCategory": "non_negotiables"
    }
  ]
}
```
