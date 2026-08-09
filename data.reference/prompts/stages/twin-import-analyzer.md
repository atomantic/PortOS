# Twin Import Analyzer

A person exported their own history from an external service and wants it turned into material for their digital twin. Infer what these choices reveal about them — their personality, values, and interests — and draft a document they can keep.

Consumption history is weak evidence. Read it as taste and habit, not as identity: what someone reads, listens to, watches, or schedules narrows the plausible range of a trait, it does not pin it. Hedge accordingly, and prefer patterns that show up repeatedly over a single striking item.

## Source

**Service**: {{source}}
**Items analyzed**: {{itemCount}}

## Data

"""
{{dataDescription}}
"""

## What to infer

1. **Patterns** — 2-5 behavioral patterns visible in the data: variety vs. repetition, mainstream vs. niche, bursts vs. steady cadence, era or genre concentration, completion vs. abandonment.
2. **Preferences** — 2-5 concrete tastes stated as preferences ("prefers character-driven literary fiction over plot-driven thrillers").
3. **Big Five estimates** — `O`, `C`, `E`, `A`, `N` as decimals from 0.0 to 1.0. These are weak inferences from consumption data; stay near 0.5 unless the pattern is strong and one-sided.
4. **Values** — 2-5 short value phrases the choices suggest.
5. **Interests** — 3-8 topics, genres, or themes they gravitate toward.
6. **Suggested document** — one markdown document summarizing the above in second person, with a `filename` in SCREAMING_SNAKE_CASE ending in `.md`, a human `title`, and a `category` chosen from exactly this list: `core`, `audio`, `behavioral`, `enrichment`, `entertainment`, `professional`, `lifestyle`, `social`, `creative`. Keep it under 350 words and do not restate the raw item list.
7. **rawSummary** — 2-3 sentences on what this export reveals about the person.

Do not name specific titles the data does not contain, and do not infer sensitive attributes (health, religion, politics, sexuality) from consumption choices.

## Output Format

Return ONLY a fenced JSON block, no prose before or after. `content` is a single JSON string with `\n` escapes for newlines:

```json
{
  "insights": {
    "patterns": ["pattern 1", "pattern 2"],
    "preferences": ["preference 1", "preference 2"],
    "personalityInferences": {
      "bigFive": { "O": 0.7, "C": 0.6, "E": 0.5, "A": 0.6, "N": 0.4 },
      "values": ["value1", "value2"],
      "interests": ["interest1", "interest2"]
    }
  },
  "suggestedDocuments": [
    {
      "filename": "READING_PROFILE.md",
      "title": "Reading Profile",
      "category": "entertainment",
      "content": "# Reading Profile\\n\\nMarkdown content here..."
    }
  ],
  "rawSummary": "2-3 sentence summary of what this data reveals about the person."
}
```
