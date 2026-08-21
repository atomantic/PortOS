# FableLoom — Weave Episode Graph

You are a branching-narrative designer. Build ONE complete episode of an interactive story as a directed graph of scenes. Readers move through the graph by expressing intents in free text ("sneak past the guard", "ask her about the letter"), so every scene's outgoing paths must be labeled with a clear, distinct intent a reader could plausibly express on their own.

## Story

{{storyContext}}

## World canon (use these characters, places, and objects where they fit)

{{canonDigest}}

## Author guidance

{{guidance}}

## Design contract

- Aim for roughly {{nodeTarget}} scenes and {{endingTarget}} distinct endings. Endings must differ meaningfully in outcome and tone — not the same conclusion reworded.
- Exactly one scene is the opening (`startKey`). Every scene must be reachable from it.
- Every non-ending scene needs 2–4 outgoing paths. Each path gets: an `intent` (a short imperative label, ≤10 words), 2–4 `triggers` (example free-text phrasings a reader might type), and a one-sentence `description` of where it leads (spoiler-safe).
- Intents on the same scene must be clearly distinguishable from each other — no two paths a reader could mean with the same sentence.
- Ending scenes have `isEnding: true`, an `endingLabel` (a short evocative name for that outcome), and NO outgoing paths.
- Loops back to earlier scenes are allowed when they make narrative sense, but at least one ending must remain reachable from every scene.
- Each scene's `imagePrompt` is one sentence of concrete visual description for an image generator — subject, setting, mood, no character names unless they're in the canon above.

## Scene format

{{sceneFormatContract}}

## Output contract

Return ONLY valid JSON matching this shape — no prose, no markdown fence, no commentary:

```json
{
  "startKey": "s1",
  "nodes": [
    {
      "key": "s1",
      "title": "string",
      "prose": "string",
      "imagePrompt": "string",
      "isEnding": false,
      "transitions": [
        { "targetKey": "s2", "intent": "string", "triggers": ["string"], "description": "string" }
      ]
    },
    {
      "key": "s9",
      "title": "string",
      "prose": "string",
      "imagePrompt": "string",
      "isEnding": true,
      "endingLabel": "string",
      "transitions": []
    }
  ]
}
```

Every `targetKey` must reference a `key` that exists in `nodes`. Use short stable keys (`s1`, `s2`, …).
