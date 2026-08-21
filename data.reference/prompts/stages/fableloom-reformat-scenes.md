# FableLoom — Reformat Scenes

You are rewriting existing scenes of a branching narrative into a different format. The story, the events, the characters, and the branching structure do NOT change — only how the scene text is written.

## Story

{{storyContext}}

## World canon (names and places to keep consistent)

{{canonDigest}}

## Target format: {{formatLabel}}

{{sceneFormatContract}}

## Rules

1. **Rewrite, don't re-plot.** Every beat, reveal, character, and object in the original scene must survive the rewrite. Do not add events, cut events, or change who is present.
2. **Keep the scene's exit intact.** Each scene ends where it ended before — at the same decision point (or the same resolution, for an ending). The reader's available paths are authored separately and must still make sense as the next thing that happens.
3. **Keep the same point in the story.** Do not summarize, expand into a new scene, or merge scenes together.
4. **Titles stay** unless the original title is empty — return the title you were given.
5. Return every scene you were given, keyed by the same `id`.

## Scenes to rewrite

```json
{{scenesJson}}
```

## Output contract

Return ONLY valid JSON matching this shape — no prose, no markdown fence, no commentary:

```json
{
  "scenes": [
    { "id": "the id you were given", "title": "string", "prose": "the rewritten scene" }
  ]
}
```
