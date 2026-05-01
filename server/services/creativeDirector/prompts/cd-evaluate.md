# Creative Director — Scene evaluation task

Your ONLY job is to evaluate a freshly-rendered scene and decide whether it works. The render itself was done by the server (no upstream task to do); the rendered video and sampled frames are already on disk.

## Project: "{{project.name}}" (id: {{project.id}})

- Aspect ratio: {{project.aspectRatio}} ({{aspect.width}}×{{aspect.height}})
- Quality: {{project.quality}} ({{quality.steps}} denoising steps, guidance {{quality.guidance}}, {{quality.fps}}fps)
- Model: {{project.modelId}}
- Target episode duration: {{project.targetDurationSeconds}}s (~{{project.targetDurationMinutes}} min)
- Collection id (group all rendered segments here): {{project.collectionId}}
{{#project.startingImageFile}}- Starting image: /data/images/{{project.startingImageFile}}{{/project.startingImageFile}}
{{^project.startingImageFile}}- Starting image: none{{/project.startingImageFile}}

## Style spec (apply to every prompt)

{{#project.styleSpec}}{{project.styleSpec}}{{/project.styleSpec}}{{^project.styleSpec}}(none — derive a coherent visual language from the project name + first scene intent){{/project.styleSpec}}

## Scene to evaluate

- Scene id: `{{scene.sceneId}}` ({{scene.positionLabel}})
- Intent: {{scene.intent}}
- Render prompt: {{scene.promptJson}}
- Render: `{{render.width}}×{{render.height}}`, {{render.numFrames}} frames @ {{render.fps}}fps
- Strategy: {{scene.strategy}}
- Retry count: {{scene.retryCount}} (max 3)
- Rendered video: `/data/videos/{{scene.renderedJobId}}.mp4`
{{#multiFrame}}
- Sampled frames across the timeline (Read EACH ONE):
{{#evaluationFrames}}
  {{position}}. `/data/video-thumbnails/{{filename}}` — {{label}}
{{/evaluationFrames}}
{{/multiFrame}}
{{^multiFrame}}
- Thumbnail (use this for evaluation): `/data/video-thumbnails/{{scene.renderedJobId}}.jpg`
{{/multiFrame}}

{{#multiFrame}}
## Step 1 — Read every sampled frame using your vision capability

Open EVERY frame above (Read tool, one per file) before deciding. Scene intent often develops mid- or late-clip — judging on frame 1 alone causes false rejects when the payoff (archway appearing, light bloom, particles converging) lands later in the timeline. Hold all frames in mind together as a sequence.
{{/multiFrame}}
{{^multiFrame}}
## Step 1 — Read the thumbnail using your vision capability

Open the thumbnail file (Read tool) and inspect the frame.
{{/multiFrame}}

## Step 2 — Score against three dimensions

1. **Style adherence**: does it match the project style spec? (Across the whole sequence, not just frame 1.)
2. **Continuity**: does it flow from the prior accepted scene's tone, color, characters? (If this is scene 1, just check it stands on its own.)
3. **Scene intent**: does it actually depict "{{scene.intent}}" by the end of the clip? Intent that arrives late still counts as delivered — accept it.

## Step 3 — Decide

Issue ONE PATCH to record your verdict, then exit. Do not request renders, do not call last-frame, do not create follow-up tasks — the server handles all of that.

```
PATCH {{apiUrl}}/api/creative-director/{{project.id}}/scene/{{scene.sceneId}}
Content-Type: application/json
```

**If the render is acceptable** (good enough — perfect is the enemy of done):
```json
{
  "status": "accepted",
  "evaluation": {
    "accepted": true,
    "score": 0.0–1.0,
    "notes": "<one-sentence reason>",
    "sampledAt": "<ISO 8601 timestamp>"
  }
}
```

Then (and ONLY in the accepted case) add the rendered video to the project's collection:
```
POST {{apiUrl}}/api/media/collections/{{project.collectionId}}/items
Content-Type: application/json

{ "kind": "video", "ref": "{{scene.renderedJobId}}" }
```
Do NOT issue this POST for the retry or failed branches below — rejected renders should not enter the collection.

**If the render misses the mark and retries are still available** (`retryCount < 3`): tweak the prompt and request a re-render. The server will run the new render and then send you back here for another evaluation.
```json
{
  "status": "pending",
  "prompt": "<refined render prompt>",
  "retryCount": {{scene.nextRetryCount}},
  "evaluation": {
    "accepted": false,
    "score": 0.0–1.0,
    "notes": "<what to fix>",
    "sampledAt": "<ISO 8601 timestamp>"
  }
}
```

**If retries are exhausted** (`retryCount >= 3`) and the render is still not acceptable, give up on this scene:
```json
{
  "status": "failed",
  "evaluation": {
    "accepted": false,
    "score": 0.0–1.0,
    "notes": "<why no further retry helps>",
    "sampledAt": "<ISO 8601 timestamp>"
  }
}
```

Then exit. The server picks up from there.
