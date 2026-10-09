# Server Services

Domain services own multi-step workflows over models, settings, and shared
infrastructure. Import the narrow service module needed by a caller; the
image-generation paths below are useful entry points when tracing render jobs.

| Module | Responsibility |
| --- | --- |
| `databaseCutoverHandshake.js` | Narrow fenced-boot path for the ordinary server: at `verifying`/`verified` prove this process's own pool reaches the recorded target, publish a per-pid proof, and wait for admission release before the app graph loads. |
| `databaseMaintenanceCutover.js` | Internal cutover worker body (transfer → forward-only `.env` mode commit → server restart with target proof → release → CoS restart) and `recoverDatabaseCutover(id)` same-operation recovery for the CLI/API. |
| `databaseMaintenanceProducers.js` | Internal one-use coordinator stage: retain producer identity, stop this install's PM2 CoS/server, and verify fresh readback while admission remains fenced. |
| `databaseMaintenanceQuiescence.js` | Internal coordinator stage after producer shutdown: terminate verified running detached-writer groups, prove every registry record quiescent from process-table evidence, archive it with the operation, and refuse pending, legacy, orphaned, ambiguous or unregistered writers. |
| `imageGen/prepareParams.js` | Shared image request preparation and the canonical local image model selector. Use `selectLocalImageModelFromSettings()` for model identity and `resolveLocalImageModel()` when the caller must also enforce local runtime, hardware, and edit-image requirements. |
| `musicVideo/renderCancellation.js` | Shared capture-abort and ffmpeg kill selection for full/excerpt renders; records explicit cancellation before signaling and classifies nonzero closes without releasing ownership. |
| `musicVideo/sharingCopy.js` | Source-hashed private sharing MP4s: queued 720p H.264/AAC export, strict decimal 100 MB cap, supervised cancellation, verified download and owned-file cleanup. |
| `mediaJobQueue/index.js` | Owns admission, lanes, durability and terminal effects; `videoHolds.js` returns local-video cohort preparation results and owns circuit breakers, `recoverySettlement.js` names the transient recovery evidence and the maintenance-permit release decision, while `videoGen/modelSelection.js` owns model-selection policy. |
| `imageGen/index.js` | Mode-aware image backend execution dispatcher. Preparation uses `lib/imageCleanDefaults.js` for cleaner policy and resolves local model identity before enqueueing. |
| `superColliderRuntime.js` | Managed SuperCollider runtime I/O (#9412): Docker probe, recipe-hash-stamped image build, `runSuperColliderContainer` (contained `sclang` run with forced container removal), the synthetic render probe and its cached evidence, `getSuperColliderStatus` and idempotent `setupSuperColliderRuntime`. Never runs at boot. |
| `superColliderRender.js` | Contained SuperCollider renders (#9413): media-queue `supercollider` jobs that snapshot source into a job-private dir, run the trusted NRT wrapper via `runSuperColliderContainer` (output quota, timeout, cancel → container force-removed), validate the decoded WAV and publish a 24 h preview + provenance sidecar (`readSuperColliderPreview`). Sweeps orphaned containers/scratch before each render. |
| `universeBuilderRender.js` | Universe Builder batch render jobs. |
| `pipeline/visualStageHelpers.js` | Shared pipeline visual prompt, LoRA compatibility, and image-job enqueue helpers. |
| `creativeStyleSources.js` | Resolves a universe style guide or mood board into art-direction text plus local reference images; shared by Code Animation and Creative Commissions. |
| `creativeDirector/firstPassGen.js` | Gracefully gated first-pass portraits and scene frames. |
| `universeCharacterSheet.js` | Character reference-sheet render and completion workflow. |
| `loraDatasetGenerate.js` | Training-image render and dataset lifecycle. |
| `sprites/reference.js` | Sprite reference candidate rendering and provenance. |
| `deckRender.js` | Deck card image render jobs. |
| `fableLoom/production.js` | FableLoom production render planning and enqueueing. |
| `appProcessTypes.js` | Dependency-free managed-app process-type vocabulary and PM2/desktop predicates. |
| `appProcessStatus.js` | PM2-backed managed-app status projections, expected-exit policy, and custom PM2 home resolution. |
