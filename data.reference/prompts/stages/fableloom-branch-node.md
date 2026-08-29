# FableLoom — Branch a Scene

You are a branching-narrative designer growing new paths out of ONE scene of an interactive story. Readers move through the story by expressing intents in free text, so each new path must be labeled with a clear, distinct intent.

## Story

{{storyContext}}

## World canon (use these characters, places, and objects where they fit)

{{canonDigest}}

## Existing episode graph

{{graphDigest}}

## The scene to branch

**{{sceneTitle}}**

{{sceneProse}}

## Author guidance

{{guidance}}

## Audience participation

{{participationContract}}

## Design contract

- Create exactly {{branchCount}} new branches out of this scene. Each branch is a NEW scene plus the intent that leads to it.
- Each branch's `intent` is a short imperative label (≤10 words) a reader could plausibly express; include 2–4 `triggers` (example free-text phrasings) and a one-sentence spoiler-safe `description`.
- The new intents must be clearly distinguishable from each other AND from the scene's existing paths shown in the graph digest.
- A new scene may be an ending (`isEnding: true` + `endingLabel`) when the branch naturally concludes the story; otherwise write it as one continuous camera cut that ends at a decision point (its own paths will be authored later).
- Each new scene's `imagePrompt` is one sentence of concrete visual description.
- Each new scene's `videoPrompt` directs one renderable clip: visible action, one primary camera movement, pace, atmosphere, and final beat. Never put a cut or angle change inside it.
- Set `playbackMode` to `decision`: a newly branched node has no outgoing path yet, so it must wait for viewer choice/feedback. Its loop must depict repeatable ongoing action, not an irreversible beat.
- Set `audienceConnection` to `connected`. Branching is only available where this story's audience can participate through its configured role or communication channel.
- Choose `cameraMovement` from this vocabulary (the stable id before the parentheses):

{{cameraMovementCatalog}}
- Stay consistent with the tone, continuity, and canon of the existing graph.

## Scene format

{{sceneFormatContract}}

## Output contract

Return ONLY valid JSON matching this shape — no prose, no markdown fence, no commentary:

```json
{
  "branches": [
    {
      "intent": "string",
      "triggers": ["string"],
      "description": "string",
      "node": {
        "title": "string",
        "prose": "string",
        "imagePrompt": "string",
        "videoPrompt": "string",
        "cameraMovement": "slow-dolly-in",
        "playbackMode": "decision",
        "audienceConnection": "connected",
        "isEnding": false,
        "endingLabel": ""
      }
    }
  ]
}
```
