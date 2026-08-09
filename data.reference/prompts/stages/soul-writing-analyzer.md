# Soul Writing Analyzer

You are extracting a person's written voice from samples they wrote themselves. The result becomes a `WRITING_STYLE.md` document that a digital twin reads before writing anything on their behalf, so it must describe *how they write*, not what the samples are about.

Judge only from the samples. Where the samples are too short or too uniform to support a judgment, say so in `overallVoice` rather than guessing.

## Writing Samples

Samples are separated by `--- Sample N ---` markers.

"""
{{samples}}
"""

## What to extract

- `formality` — one of `casual`, `conversational`, `neutral`, `professional`, `formal`
- `directness` — integer 1 (hedged, softened, indirect) to 10 (blunt, states the point first)
- `warmth` — integer 1 (cool, transactional) to 10 (warm, personal)
- `humor` — one of `none`, `dry`, `playful`, `sarcastic`, `frequent`
- `avgSentenceLength` — approximate words per sentence
- `vocabulary` — a short note on register: plain vs. technical, jargon, profanity, regionalisms
- `structure` — a short note on how they organize a message: lead with the ask, bullet lists, long paragraphs, sign-offs
- `punctuationHabits` — em dashes, ellipses, exclamation marks, lowercase starts, emoji use
- `distinctiveMarkers` — up to 6 short phrases, openers, closers, or tics that recur across samples
- `overallVoice` — 2-3 sentences describing the voice as a whole, including anything the samples could not settle

Then write `suggestedContent`: a complete, ready-to-save markdown document capturing this voice as instructions to the twin. Use a `# Writing Style` heading, short sections, and imperative guidance ("Lead with the ask." / "Never open with 'I hope this finds you well.'"). Include a "Do" and "Don't" list and two short before/after examples in this person's voice. Keep it under 400 words.

## Output Format

Return ONLY a fenced JSON block, no prose before or after. `suggestedContent` is a single JSON string with `\n` escapes for newlines:

```json
{
  "analysis": {
    "formality": "conversational",
    "directness": 7,
    "warmth": 6,
    "humor": "dry",
    "avgSentenceLength": 14,
    "vocabulary": "Plain, occasional domain jargon, no profanity.",
    "structure": "Opens with the ask, then two short supporting paragraphs, no sign-off.",
    "punctuationHabits": "Frequent em dashes, rare exclamation marks, no emoji.",
    "distinctiveMarkers": ["Short version:", "worth a look"],
    "overallVoice": "2-3 sentences."
  },
  "suggestedContent": "# Writing Style\\n\\n..."
}
```
