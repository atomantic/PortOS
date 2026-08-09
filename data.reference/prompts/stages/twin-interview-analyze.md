# Twin Interview Analyzer

A person pasted the results of a personality assessment, an interview transcript, or a self-description. Fold it into their existing digital twin: update the quantitative traits where the new material justifies a change, and draft the documents worth keeping.

The pasted content is the new evidence. The existing twin content and traits are the prior. Move a score only as far as the new evidence warrants, and leave a trait out entirely rather than restating the prior value unchanged.

## Existing Twin Content

"""
{{twinContent}}
"""

## Current Traits

```json
{{currentTraits}}
```

## Pasted Content

"""
{{pastedContent}}
"""

## Instructions

1. **Identify the format first.** A scored instrument (Big Five, MBTI, Enneagram, StrengthsFinder, DISC) gives you numbers to map; a transcript or free-form description gives you passages to read. Map percentile or 1-100 instrument scores onto the 0.0-1.0 scale; never copy a raw percentile in as a decimal.
2. **`bigFive`** — include only the dimensions the pasted content actually speaks to, as decimals from 0.0 to 1.0. Omit the key entirely if it speaks to none.
3. **`valuesHierarchy`** — up to 10 entries, each `{ value, priority, description }` with `priority` starting at 1 for the most important. Include this only when the pasted content ranks or argues about what matters to them; a passing mention is not a ranking.
4. **`communicationProfile`** — `formality` and `verbosity` as integers 1-10, optional `avgSentenceLength`, `emojiUsage` of `never`/`rare`/`occasional`/`frequent`, a short `preferredTone`, and up to 10 `distinctiveMarkers`. Include only when the pasted content shows how they communicate.
5. **`suggestedDocuments`** — markdown documents capturing what the pasted content adds. Reuse an existing filename from the twin content above when this material belongs in that document (it will be updated in place); otherwise pick a new SCREAMING_SNAKE_CASE `.md` filename. Give each a `category` from exactly this list: `core`, `audio`, `behavioral`, `enrichment`, `entertainment`, `professional`, `lifestyle`, `social`, `creative`. Write the full replacement content, in second person, under 500 words each. Skip documents that would only restate what the twin already has.
6. **`newDimensions`** — short labels for facets this material introduced that the twin had no coverage of before.
7. **`summary`** — 2-3 sentences on what changed and what is still missing.

Do not invent scores for an instrument the person did not take, and do not carry an instrument's own prose into a document as if the person wrote it.

## Output Format

Return ONLY a fenced JSON block, no prose before or after. Every key is optional except `summary` — omit what the pasted content does not support:

```json
{
  "bigFive": { "O": 0.0, "C": 0.0, "E": 0.0, "A": 0.0, "N": 0.0 },
  "valuesHierarchy": [
    { "value": "Autonomy", "priority": 1, "description": "Grounded in the pasted content." }
  ],
  "communicationProfile": {
    "formality": 4,
    "verbosity": 5,
    "emojiUsage": "rare",
    "preferredTone": "Direct and warm",
    "distinctiveMarkers": ["Short version:"]
  },
  "suggestedDocuments": [
    {
      "filename": "PERSONALITY_ASSESSMENT.md",
      "title": "Personality Assessment",
      "category": "enrichment",
      "content": "# Personality Assessment\\n\\n..."
    }
  ],
  "newDimensions": ["stress response"],
  "summary": "What this material added and what is still unmeasured."
}
```
