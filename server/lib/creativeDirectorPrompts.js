/**
 * Creative Director — agent prompt templates.
 *
 * Only two cognitive steps require an agent:
 *   - `treatment`: write the story + scene plan
 *   - `evaluate` : judge a single rendered scene against the style spec
 *
 * Programmatic steps (per-scene render orchestration, final stitch) live
 * server-side in services/creativeDirector/{sceneRunner,stitchRunner}.js
 * and never spawn an agent.
 */

import { ASPECT_PRESETS, QUALITY_PRESETS, presetToRenderParams } from './creativeDirectorPresets.js';

// Common header. Project context the agent always needs to know.
function projectBlock(project) {
  const aspect = ASPECT_PRESETS[project.aspectRatio];
  const q = QUALITY_PRESETS[project.quality];
  return [
    `## Project: "${project.name}" (id: ${project.id})`,
    ``,
    `- Aspect ratio: ${project.aspectRatio} (${aspect.width}×${aspect.height})`,
    `- Quality: ${project.quality} (${q.steps} denoising steps, guidance ${q.guidance}, ${q.fps}fps)`,
    `- Model: ${project.modelId}`,
    `- Target episode duration: ${project.targetDurationSeconds}s (~${Math.round(project.targetDurationSeconds / 60)} min)`,
    `- Collection id (group all rendered segments here): ${project.collectionId}`,
    project.startingImageFile ? `- Starting image: /data/images/${project.startingImageFile}` : `- Starting image: none`,
    ``,
    `## Style spec (apply to every prompt)`,
    project.styleSpec || '(none — derive a coherent visual language from the project name + first scene intent)',
    ``,
  ].join('\n');
}

export function buildTreatmentPrompt(project) {
  const userStoryBlock = project.userStory
    ? `## User-supplied story\n\nThe user provided this outline. Honor it; expand/refine but don't contradict.\n\n${project.userStory}\n\n`
    : `## Story\n\nThe user did not supply a story. Invent one that suits the style spec and target duration.\n\n`;

  return [
    `# Creative Director — Treatment task`,
    ``,
    `You are the Creative Director for a long-form generated-video project. Your job in this task is to produce a TREATMENT — a complete scene-by-scene plan that the server will then render scene-by-scene (no further agent task is needed for rendering — the server orchestrates that). After each render lands, a separate short evaluation task will judge it.`,
    ``,
    projectBlock(project),
    userStoryBlock,
    `## Task`,
    ``,
    `1. Design a story arc that fits ~${project.targetDurationSeconds}s of total runtime. Think in scenes that are 1–10 seconds each (most should be 4–6s; reserve short ones for cuts and long ones for held shots).`,
    `2. Each scene should have a clear visual intent and a render prompt that incorporates the style spec.`,
    `3. Decide for each scene whether it continues from the previous scene's last frame (\`useContinuationFromPrior: true\`) or starts from a new image (\`useContinuationFromPrior: false\`, optionally with a \`sourceImageFile\` basename if you want to seed from a specific gallery image). Scene 1 either uses the project starting image (if provided — copy its filename into \`sourceImageFile\`) or starts as text-to-video.`,
    `4. Don't pad with filler; if the natural arc is shorter than the target, that's fine — produce fewer scenes.`,
    ``,
    `## Output contract`,
    ``,
    `Issue ONE HTTP request to update the project with the treatment, then exit:`,
    ``,
    `\`\`\``,
    `PATCH http://localhost:5555/api/creative-director/${project.id}/treatment`,
    `Content-Type: application/json`,
    ``,
    `{`,
    `  "logline": "<one-sentence high-concept>",`,
    `  "synopsis": "<short paragraph synopsis>",`,
    `  "scenes": [`,
    `    {`,
    `      "sceneId": "scene-1",`,
    `      "order": 0,`,
    `      "intent": "<what this scene does narratively/visually>",`,
    `      "prompt": "<full render prompt with style spec inlined>",`,
    `      "negativePrompt": "<optional>",`,
    `      "durationSeconds": 5,`,
    `      "useContinuationFromPrior": false,`,
    `      "sourceImageFile": ${project.startingImageFile ? `"${project.startingImageFile}"` : 'null'}`,
    `    },`,
    `    { "sceneId": "scene-2", "order": 1, ..., "useContinuationFromPrior": true }`,
    `  ]`,
    `}`,
    `\`\`\``,
    ``,
    `On a 200 response your task is complete. The server will automatically begin rendering scene 1 — do not create any additional tasks yourself.`,
    ``,
    `If the PATCH returns 4xx, fix the validation issue (read the error body) and retry. Do not retry on 5xx more than twice.`,
  ].join('\n');
}

export function buildEvaluatePrompt(project, scene) {
  const renderParams = presetToRenderParams({
    aspectRatio: project.aspectRatio,
    quality: project.quality,
    durationSeconds: scene.durationSeconds,
  });
  const renderedId = scene.renderedJobId || '<unknown>';
  return [
    `# Creative Director — Scene evaluation task`,
    ``,
    `Your ONLY job is to evaluate a freshly-rendered scene and decide whether it works. The render itself was done by the server (no upstream task to do); the rendered video and its thumbnail are already on disk.`,
    ``,
    projectBlock(project),
    `## Scene to evaluate`,
    ``,
    `- Scene id: \`${scene.sceneId}\` (${scene.order + 1}/${project.treatment?.scenes?.length || '?'})`,
    `- Intent: ${scene.intent}`,
    `- Render prompt: ${JSON.stringify(scene.prompt)}`,
    `- Render: \`${renderParams.width}×${renderParams.height}\`, ${renderParams.numFrames} frames @ ${renderParams.fps}fps`,
    `- Strategy: ${scene.useContinuationFromPrior ? 'continued from prior scene last-frame' : (scene.sourceImageFile ? `seeded from image \`${scene.sourceImageFile}\`` : 'text-to-video')}`,
    `- Retry count: ${scene.retryCount || 0} (max 3)`,
    `- Rendered video: \`/data/videos/${renderedId}.mp4\``,
    `- Thumbnail (use this for evaluation): \`/data/video-thumbnails/${renderedId}.jpg\``,
    ``,
    `## Step 1 — Read the thumbnail using your vision capability`,
    ``,
    `Open the thumbnail file (Read tool) and inspect the frame.`,
    ``,
    `## Step 2 — Score against three dimensions`,
    ``,
    `1. **Style adherence**: does it match the project style spec?`,
    `2. **Continuity**: does it flow from the prior accepted scene's tone, color, characters? (If this is scene 1, just check it stands on its own.)`,
    `3. **Scene intent**: does it actually depict "${scene.intent}"?`,
    ``,
    `## Step 3 — Decide`,
    ``,
    `Issue ONE PATCH to record your verdict, then exit. Do not request renders, do not call last-frame, do not create follow-up tasks — the server handles all of that.`,
    ``,
    `\`\`\``,
    `PATCH http://localhost:5555/api/creative-director/${project.id}/scene/${scene.sceneId}`,
    `Content-Type: application/json`,
    `\`\`\``,
    ``,
    `**If the render is acceptable** (good enough — perfect is the enemy of done):`,
    `\`\`\`json`,
    `{`,
    `  "status": "accepted",`,
    `  "evaluation": {`,
    `    "accepted": true,`,
    `    "score": 0.0–1.0,`,
    `    "notes": "<one-sentence reason>",`,
    `    "sampledAt": "<ISO 8601 timestamp>"`,
    `  }`,
    `}`,
    `\`\`\``,
    ``,
    `Then (and ONLY in the accepted case) add the rendered video to the project's collection:`,
    `\`\`\``,
    `POST http://localhost:5555/api/media/collections/${project.collectionId}/items`,
    `Content-Type: application/json`,
    ``,
    `{ "kind": "video", "ref": "${renderedId}" }`,
    `\`\`\``,
    `Do NOT issue this POST for the retry or failed branches below — rejected renders should not enter the collection.`,
    ``,
    `**If the render misses the mark and retries are still available** (\`retryCount < 3\`): tweak the prompt and request a re-render. The server will run the new render and then send you back here for another evaluation.`,
    `\`\`\`json`,
    `{`,
    `  "status": "pending",`,
    `  "prompt": "<refined render prompt>",`,
    `  "retryCount": ${(scene.retryCount || 0) + 1},`,
    `  "evaluation": {`,
    `    "accepted": false,`,
    `    "score": 0.0–1.0,`,
    `    "notes": "<what to fix>",`,
    `    "sampledAt": "<ISO 8601 timestamp>"`,
    `  }`,
    `}`,
    `\`\`\``,
    ``,
    `**If retries are exhausted** (\`retryCount >= 3\`) and the render is still not acceptable, give up on this scene:`,
    `\`\`\`json`,
    `{`,
    `  "status": "failed",`,
    `  "evaluation": {`,
    `    "accepted": false,`,
    `    "score": 0.0–1.0,`,
    `    "notes": "<why no further retry helps>",`,
    `    "sampledAt": "<ISO 8601 timestamp>"`,
    `  }`,
    `}`,
    `\`\`\``,
    ``,
    `Then exit. The server picks up from there.`,
  ].join('\n');
}
