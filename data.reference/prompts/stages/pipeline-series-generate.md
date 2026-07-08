# Pipeline — Generate Series Concepts

You are a showrunner / series developer. Invent **{{count}} genuinely distinct new series**, each of which lives inside the universe described below — a self-contained story with its own protagonist, conflict, and arc. The universe is the shared world (its tone, rules, places, and cast); each series is *one story told within it*, not a retelling of the world itself.

The point of proposing several is **diversity of premise**: the concepts must not be minor variations of one idea. Push each into a different corner of the world, a different kind of protagonist, a different engine of conflict. Concept variety at the seed is the cheapest quality lever in the whole pipeline — everything downstream inherits it.

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

Each new series MUST tell a **different story** from the ones above AND from each other — a different protagonist, a different central conflict, or a different corner of the world. Do not duplicate an existing premise or logline. It is fine to share canon (the same city, a recurring character), but the spine of each story must be new and the {{count}} concepts must be distinct from one another.

## Anti-generic banlist (do NOT reach for these)

The following are exhausted, default-mode ideas a reader who has seen a thousand pitches will scroll right past. Do not build a concept on any of them; if the universe's own avoid-influences appear here they are doubly forbidden:

{{banlist}}

Steering clear of a banned trope does not mean avoiding the genre — it means finding the fresh, specific version instead of the tired default.

## Story shapes (choose the one that best fits each arc you propose)

{{shapes}}

## What to write — for EACH of the {{count}} concepts

1. **name** — a distinctive series title (not the universe's name). Short, evocative, 1–5 words.
2. **logline** — one sentence: protagonist + their goal + the obstacle/stakes. Concrete, not abstract.
3. **premise** — 1–3 short paragraphs: the setting within the universe, the central conflict, the stakes, the tone. This is the elevator pitch a reader sees on the series page.
4. **shape** — the single best-fitting story-shape id from the list above (e.g. `man-in-hole`). Pick the one whose emotional curve matches the arc your premise implies.
5. **hook** — one sentence that makes someone pick this up over everything else on the shelf.
6. **world** — what is genuinely new or specific here, beyond the shared universe (the angle no other pitch would take).
7. **conflictEngine** — the situation that keeps generating stories issue after issue (not a single event — an ongoing pressure).
8. **cost** — what that conflict *charges* the protagonist: the price, the trade-off, what pursuing the goal takes away.
9. **tension** — the stakes at BOTH scales: a personal, intimate stake AND a larger (societal / cosmic / systemic) one, and how they pull against each other.
10. **theme** — the question the series is really about, under the plot.

## Rules

- Stay inside the universe's tone and rules — honor the embrace influences, steer clear of the avoid influences and the banlist above.
- Make each producible as a serialized comic / TV series (an ongoing arc, not a one-shot).
- Don't restate the universe premise back as a series premise — each series is one story, narrower and more specific than the world.
- `shape` must be exactly one of the ids listed above. If genuinely unsure, pick the closest fit rather than omitting it.
- Return exactly {{count}} concepts, each meaningfully different from the others.

## Output

Return ONLY valid JSON in this exact shape:

```json
{
  "candidates": [
    {
      "name": "<series title, 1–5 words>",
      "logline": "<one-sentence logline>",
      "premise": "<1–3 paragraph premise>",
      "shape": "<one story-shape id from the list>",
      "hook": "<one sentence that makes someone pick this up>",
      "world": "<what's genuinely new/specific here>",
      "conflictEngine": "<the ongoing situation that generates stories>",
      "cost": "<what the conflict charges the protagonist>",
      "tension": "<personal stake AND larger-scale stake, in tension>",
      "theme": "<the question under the plot>"
    }
  ],
  "rationale": "<one short sentence for the user on which concept you'd lean toward and why — not stored>"
}
```
