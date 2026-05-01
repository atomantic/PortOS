/**
 * Creative Director — agent prompt templates for the three task kinds:
 * treatment (initial story planning), scene (single segment render +
 * evaluation), and stitch (final concat). The agent runs as a CoS task and
 * receives one of these strings via task.metadata.context.
 *
 * Constraint surface: every prompt tells the agent which exact PortOS HTTP
 * endpoints to call and what payload shape to send. The agent does NOT call
 * `addTask` itself for follow-ups — the server's completion hook owns that
 * (see services/creativeDirector/agentBridge.js).
 */

import { ASPECT_PRESETS, QUALITY_PRESETS, presetToRenderParams } from './creativeDirectorPresets.js';

function renderPriorRefBlock(scene, priorScene) {
  if (scene.useContinuationFromPrior && priorScene) {
    return `### Continuation from prior scene\n\nPrior accepted scene: ${priorScene.sceneId} (renderedJobId: ${priorScene.renderedJobId}).\n\nFirst, extract its last frame:\n\n\`\`\`\nPOST http://localhost:5555/api/video-gen/last-frame/${priorScene.renderedJobId}\n\`\`\`\n\nThe response gives you \`{ filename }\`. Use that as the \`sourceImageFile\` in the render request below.\n`;
  }
  if (scene.useContinuationFromPrior) {
    return `### Continuation requested but no prior scene available\n\nFalling back to text-to-video for this scene. Do NOT call last-frame.\n`;
  }
  if (scene.sourceImageFile) return `### Starts from image: \`${scene.sourceImageFile}\``;
  return `### Text-to-video (no source image)`;
}

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
    `You are the Creative Director for a long-form generated-video project. Your job in this task is to produce a TREATMENT — a complete scene-by-scene plan that a sequence of follow-up "scene" tasks will then render.`,
    ``,
    projectBlock(project),
    userStoryBlock,
    `## Task`,
    ``,
    `1. Design a story arc that fits ~${project.targetDurationSeconds}s of total runtime. Think in scenes that are 1–10 seconds each (most should be 4–6s; reserve short ones for cuts and long ones for held shots).`,
    `2. Each scene should have a clear visual intent and a render prompt that incorporates the style spec.`,
    `3. Decide for each scene whether it continues from the previous scene's last frame (\`useContinuationFromPrior: true\`) or starts from a new image (use a fresh prompt with no source image, or specify a sourceImageFile if the user already provided a starting image you want to reuse). Scene 1 either uses the project starting image (if provided — copy its filename into \`sourceImageFile\`) or starts as text-to-video (\`useContinuationFromPrior: false\` and no \`sourceImageFile\`).`,
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
    `On a 200 response your task is complete. The server will automatically queue the first scene render task next. Do not create any additional tasks yourself.`,
    ``,
    `If the PATCH returns 4xx, fix the validation issue (read the error body) and retry. Do not retry on 5xx more than twice.`,
  ].join('\n');
}

export function buildScenePrompt(project, scene) {
  const renderParams = presetToRenderParams({
    aspectRatio: project.aspectRatio,
    quality: project.quality,
    durationSeconds: scene.durationSeconds,
  });
  const priorScene = project.treatment?.scenes
    ?.filter((s) => s.order < scene.order && s.status === 'accepted')
    ?.sort((a, b) => b.order - a.order)?.[0] || null;
  const priorRefBlock = renderPriorRefBlock(scene, priorScene);

  return [
    `# Creative Director — Scene task`,
    ``,
    projectBlock(project),
    `## Scene to render`,
    ``,
    `- Scene id: \`${scene.sceneId}\` (order ${scene.order})`,
    `- Intent: ${scene.intent}`,
    `- Duration: ${scene.durationSeconds}s → ${renderParams.numFrames} frames @ ${renderParams.fps}fps`,
    `- Retry count so far: ${scene.retryCount} (max 3)`,
    ``,
    priorRefBlock,
    ``,
    `## Render`,
    ``,
    `Submit the render and watch the SSE stream until it terminates:`,
    ``,
    `\`\`\``,
    `POST http://localhost:5555/api/video-gen`,
    `Content-Type: application/json`,
    ``,
    `{`,
    `  "prompt": ${JSON.stringify(scene.prompt)},`,
    scene.negativePrompt ? `  "negativePrompt": ${JSON.stringify(scene.negativePrompt)},` : `  "negativePrompt": "",`,
    `  "modelId": "${project.modelId}",`,
    `  "width": ${renderParams.width},`,
    `  "height": ${renderParams.height},`,
    `  "numFrames": ${renderParams.numFrames},`,
    `  "fps": ${renderParams.fps},`,
    `  "steps": ${renderParams.steps},`,
    `  "guidanceScale": ${renderParams.guidanceScale},`,
    scene.useContinuationFromPrior
      ? `  "sourceImageFile": "<filename returned by last-frame call above>",`
      : scene.sourceImageFile
        ? `  "sourceImageFile": "${scene.sourceImageFile}",`
        : `  // (no sourceImageFile — text-to-video)`,
    `  "mode": "${scene.useContinuationFromPrior || scene.sourceImageFile ? 'image' : 'text'}"`,
    `}`,
    `\`\`\``,
    ``,
    `Response: \`{ "jobId", "status": "queued"|..., "position", "filename" }\`. The render system queues all submissions — you will NEVER see a BUSY error. Subscribe to:`,
    ``,
    `\`\`\``,
    `GET http://localhost:5555/api/video-gen/{jobId}/events  (SSE)`,
    `\`\`\``,
    ``,
    `Wait for the \`{ "type": "complete" }\` event. The result includes \`thumbnail\` (basename in \`/data/video-thumbnails/\`) and \`path\` (the final mp4).`,
    ``,
    `## Evaluate`,
    ``,
    `Read the thumbnail file at \`/data/video-thumbnails/<thumbnail>\` using your vision capability. Score against:`,
    `1. Style adherence — does it match the style spec?`,
    `2. Continuity — does it flow from the prior scene's tone, color, characters?`,
    `3. Scene intent — does it actually depict "${scene.intent}"?`,
    ``,
    `Decide \`accepted: true | false\`. If false and \`retryCount < 3\`: tweak the prompt (more specific style language, stronger negative prompt, or adjust mood) and re-render — repeat the POST + SSE wait. Track your retries via the PATCH below.`,
    ``,
    `## Finalize the scene`,
    ``,
    `Once you accept (or hit retry=3 and give up):`,
    ``,
    `\`\`\``,
    `PATCH http://localhost:5555/api/creative-director/${project.id}/scene/${scene.sceneId}`,
    `Content-Type: application/json`,
    ``,
    `{`,
    `  "status": "accepted" | "failed",`,
    `  "retryCount": <final count>,`,
    `  "renderedJobId": "<jobId>",`,
    `  "evaluation": { "score": 0.0-1.0, "notes": "<short reason>", "accepted": true|false, "sampledAt": "<iso8601>" }`,
    `}`,
    `\`\`\``,
    ``,
    `Then add the rendered video to the project's collection (only if accepted):`,
    ``,
    `\`\`\``,
    `POST http://localhost:5555/api/media/collections/${project.collectionId}/items`,
    `Content-Type: application/json`,
    ``,
    `{ "kind": "video", "ref": "<jobId>" }`,
    `\`\`\``,
    ``,
    `Then exit. The server will queue the next scene (or the final stitch) on its own.`,
  ].join('\n');
}

export function buildStitchPrompt(project) {
  const accepted = (project.treatment?.scenes || [])
    .filter((s) => s.status === 'accepted' && s.renderedJobId)
    .sort((a, b) => a.order - b.order);
  if (!accepted.length) {
    return [
      `# Creative Director — Stitch task`,
      ``,
      `Project ${project.id} has no accepted scenes. Mark it failed:`,
      ``,
      `\`\`\``,
      `PATCH http://localhost:5555/api/creative-director/${project.id}`,
      `Content-Type: application/json`,
      ``,
      `{ "status": "failed" }`,
      `\`\`\``,
    ].join('\n');
  }
  return [
    `# Creative Director — Stitch task`,
    ``,
    projectBlock(project),
    `## Task`,
    ``,
    `All ${accepted.length} scenes are rendered and accepted. Stitch them into a single episode video using the existing video-timeline pipeline.`,
    ``,
    `### Step 1: Create a timeline project`,
    ``,
    `\`\`\``,
    `POST http://localhost:5555/api/video-timeline/projects`,
    `Content-Type: application/json`,
    ``,
    `{ "name": "${project.name} — Final Cut" }`,
    `\`\`\``,
    ``,
    `Response: \`{ "id": "<timelineProjectId>" }\`.`,
    ``,
    `### Step 2: Set the clips`,
    ``,
    `\`\`\``,
    `PATCH http://localhost:5555/api/video-timeline/projects/<timelineProjectId>`,
    `Content-Type: application/json`,
    ``,
    `{`,
    `  "clips": [`,
    ...accepted.map((s, i) => `    { "clipId": "${s.renderedJobId}", "inSec": 0, "outSec": ${s.durationSeconds} }${i < accepted.length - 1 ? ',' : ''}`),
    `  ]`,
    `}`,
    `\`\`\``,
    ``,
    `### Step 3: Render the concat`,
    ``,
    `\`\`\``,
    `POST http://localhost:5555/api/video-timeline/projects/<timelineProjectId>/render`,
    `\`\`\``,
    ``,
    `Response: \`{ "jobId" }\`. Subscribe to \`GET /api/video-timeline/{jobId}/events\` and wait for \`complete\`. The result has \`{ "filename", "id" }\` — the id is the final video's history id.`,
    ``,
    `### Step 4: Mark the project complete`,
    ``,
    `\`\`\``,
    `PATCH http://localhost:5555/api/creative-director/${project.id}`,
    `Content-Type: application/json`,
    ``,
    `{ "status": "complete", "timelineProjectId": "<timelineProjectId>", "finalVideoId": "<finalVideoId>" }`,
    `\`\`\``,
    ``,
    `Add the final video to the project's collection too:`,
    ``,
    `\`\`\``,
    `POST http://localhost:5555/api/media/collections/${project.collectionId}/items`,
    `Content-Type: application/json`,
    ``,
    `{ "kind": "video", "ref": "<finalVideoId>" }`,
    `\`\`\``,
    ``,
    `Then exit.`,
  ].join('\n');
}
