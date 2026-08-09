# Twin Trait Extractor

You are converting a person's digital-twin documents into a quantitative personality profile. The numbers you return are stored and used to steer how the twin behaves, so they must be grounded in the text — not in a generic average person.

Only score what the documents support. When the evidence for a dimension is thin, score it toward the middle (0.5) and say why in `analysisNotes` rather than inventing a confident extreme.

## Twin Content

"""
{{twinContent}}
"""

## Output fields

**`bigFive`** — OCEAN scores as decimals from 0.0 to 1.0 (not percentages):

- `O` openness — curiosity, appetite for novelty and abstraction
- `C` conscientiousness — planning, follow-through, structure
- `E` extraversion — energy from people, outward orientation
- `A` agreeableness — cooperation, empathy, deference to group harmony
- `N` neuroticism — reactivity to stress, worry, emotional volatility

**`valuesHierarchy`** — up to 10 values this person actually acts on, most important first. Each has a `value` (short noun phrase), a `priority` integer from 1 (most important) ascending, a one-sentence `description` grounded in the documents, and optionally `conflictsWith` naming other values in this list that it trades against.

**`communicationProfile`**:

- `formality` — integer 1 (very casual) to 10 (very formal)
- `verbosity` — integer 1 (terse) to 10 (elaborate)
- `avgSentenceLength` — approximate words per sentence, between 5 and 50
- `emojiUsage` — one of `never`, `rare`, `occasional`, `frequent`
- `preferredTone` — a short phrase, under 100 characters
- `distinctiveMarkers` — up to 10 recurring phrases or habits

**`analysisNotes`** — 2-4 sentences naming the strongest evidence you used and the dimensions the documents left underdetermined.

## Output Format

Return ONLY a fenced JSON block, no prose before or after:

```json
{
  "bigFive": { "O": 0.0, "C": 0.0, "E": 0.0, "A": 0.0, "N": 0.0 },
  "valuesHierarchy": [
    { "value": "Craft", "priority": 1, "description": "Why this ranks here, from the documents.", "conflictsWith": ["Speed"] }
  ],
  "communicationProfile": {
    "formality": 4,
    "verbosity": 5,
    "avgSentenceLength": 16,
    "emojiUsage": "rare",
    "preferredTone": "Direct and warm",
    "distinctiveMarkers": ["Short version:"]
  },
  "analysisNotes": "What the evidence supported and what it did not."
}
```
