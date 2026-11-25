import { EventEmitter } from 'events';

// Event bus for Music Video async side effects that must reach the client after
// the originating HTTP request returned. socket.js bridges client-facing events
// to `music-video:<name>` on Socket.IO; "server-only" ones never leave the process.
//
//   'scene-image' -> { projectId, sceneId, referenceImageId, endImageId, takes, takeId, lastFailure }
//   'scene-video' -> { projectId, sceneId, videoHistoryId, takes, takeId, lastFailure }
//     Emitted by `musicVideoSceneImageHook` / `musicVideoSceneVideoHook` once an
//     async render is appended to the scene's takes. `referenceImageId` /
//     `videoHistoryId` carry the CURRENT selection (a new take only fills an empty
//     slot), `takes` the full candidate list, `lastFailure` is null once a take lands.
//   'scene-failure' -> { projectId, sceneId, lastFailure: { lane, error, at } | null }
//     A render FAILED and the failure is persisted on the scene (#10154).
//   'shot-render' -> { projectId, sceneId, state: 'rendering'|'rendered'|'failed'|'canceled', progress?, error?, startedAt?, failedAt? }
//     A shot's cached render segment advancing (shotSegments.js). `startedAt` (ms)
//     identifies one render attempt on every 'rendering' event; `failedAt` (ISO)
//     and `error` ride on 'failed'. GET /shot-renders returns that failure until
//     the shot renders or restarts.
//   'render-spend' -> { projectId, renderSpend }
//     A paid render reached the project's spend ledger, or an adjustment changed it (#16506).
//     `renderSpend` is the summary a project read carries (lib/musicVideo/musicVideoSpend.js).
//   'excerpt-render' -> { projectId, excerptId, status }   (server-only)
//     A draft excerpt render settled; an auto-review run waiting on it continues.
//   'auto-review' -> { projectId, runId, run, action, project }
//     An auto-review run advanced. A run a production owns (`run.productionRunId`)
//     is dispatched server-side instead.
//   'production' -> { projectId, runId, run, action, project }
//     A server-owned production run advanced (steps, route choices, spend, halts).
//   'autonomous' -> { projectId, runId, run }
//     An autonomous run (autonomousService.js) changed stage or status.
//   'render' -> { projectId, jobId, status: 'completed'|'failed'|'canceled', error, abandoned? }   (server-only)
//     A final render job settled: its project write landed and its render slot is free.
//     `abandoned: true` means the song changed under it, so the project does not name this render.
//   'audio-changed' -> { projectId, project }   (server-only)
//     A project write changed the song (`audioRevision`); finalRenderJob.js cancels this
//     instance's render of the old song (#15154).
//   'cast-and-sets' -> { projectId, stage, project }
//     The Cast & Sets check-in advanced; productionService.js also listens so a
//     waiting production run continues once it settles.
//   'dev-artifact' -> { projectId, artifactId, project }
//     A development artifact was added, versioned, noted, reviewed or deleted.
//   'publish-draft' -> { projectId, draftId, target, state }
//     A publish draft's tab was filled ('open'), closed ('closed') or discarded.
//     'posted' adds `url` and `project`. 'queued' / 'filling' carry no draftId,
//     only a `message` (what the fill waits on or is doing).
//   'cover-art' -> { projectId, project }
//     Release cover art was composed, or a cover source image was queued, landed or failed.
//   'blender' -> { projectId, kind: 'job', job } | { projectId, kind: 'state' }
//     (services/musicVideo/blender/) A sync, shot render or cut job was queued,
//     advanced (at most four frames a second per job) or ended; 'state' means
//     settings, source, manifest, a note or a cut changed outside a job.
export const musicVideoEvents = new EventEmitter();
