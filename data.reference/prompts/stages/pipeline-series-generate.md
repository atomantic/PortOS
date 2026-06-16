# Pipeline — Generate Series Concept

You are a showrunner / series developer. Invent **one new series** that lives inside the universe described below — a self-contained story with its own protagonist, conflict, and arc. The universe is the shared world (its tone, rules, places, and cast); the series is *one story told within it*, not a retelling of the world itself.

## Universe (seed material)

- **Name:** {{universe.name}}
- **Logline:** {{universe.logline}}
- **Premise:** {{universe.premise}}
- **Tone / style notes:** {{universe.styleNotes}}
- **Embrace influences:** {{universe.embrace}}
- **Avoid influences:** {{universe.avoid}}

### Canon you may draw on (reuse freely, or introduce new players that fit)

- **Characters:** {{characters}}
- **Places:** {{places}}
- **Objects:** {{objects}}

## Existing series in this universe

{{existingSeries}}

Your new series MUST tell a **different story** from the ones above — a different protagonist, a different central conflict, or a different corner of the world. Do not duplicate an existing premise or logline. It is fine to share canon (the same city, a recurring character), but the spine of the story must be new.

## Story shapes (choose the one that best fits the arc you're proposing)

{{shapes}}

## What to write

1. **name** — a distinctive series title (not the universe's name). Short, evocative, 1–5 words.
2. **logline** — one sentence: protagonist + their goal + the obstacle/stakes. Concrete, not abstract.
3. **premise** — 1–3 short paragraphs: the setting within the universe, the central conflict, the stakes, the tone. This is the elevator pitch a reader sees on the series page.
4. **shape** — the single best-fitting story-shape id from the list above (e.g. `man-in-hole`). Pick the one whose emotional curve matches the arc your premise implies.

## Rules

- Stay inside the universe's tone and rules — honor the embrace influences, steer clear of the avoid influences.
- Make it producible as a serialized comic / TV series (an ongoing arc, not a one-shot).
- Don't restate the universe premise back as the series premise — the series is one story, narrower and more specific than the world.
- `shape` must be exactly one of the ids listed above. If genuinely unsure, pick the closest fit rather than omitting it.

## Output

Return ONLY valid JSON in this exact shape:

```json
{
  "name": "<series title, 1–5 words>",
  "logline": "<one-sentence logline>",
  "premise": "<1–3 paragraph premise>",
  "shape": "<one story-shape id from the list>",
  "rationale": "<one short sentence on why this story + shape fits the universe — for the user, not stored>"
}
```
