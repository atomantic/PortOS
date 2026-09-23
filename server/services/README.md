# Server Services

Domain services own multi-step workflows over models, settings, and shared
infrastructure. Import the narrow service module needed by a caller; the
image-generation paths below are useful entry points when tracing render jobs.

| Module | Responsibility |
| --- | --- |
| `imageGen/prepareParams.js` | Shared image request preparation and the canonical local image model selector. Use `selectLocalImageModelFromSettings()` for model identity and `resolveLocalImageModel()` when the caller must also enforce local runtime, hardware, and edit-image requirements. |
| `imageGen/index.js` | Mode-aware image backend dispatcher and shared image-generation helpers. Direct queue consumers still resolve local model identity before enqueueing. |
| `universeBuilderRender.js` | Universe Builder batch render jobs. |
| `pipeline/visualStageHelpers.js` | Shared pipeline visual prompt, LoRA compatibility, and image-job enqueue helpers. |
| `creativeDirector/firstPassGen.js` | Gracefully gated first-pass portraits and scene frames. |
| `universeCharacterSheet.js` | Character reference-sheet render and completion workflow. |
| `loraDatasetGenerate.js` | Training-image render and dataset lifecycle. |
| `sprites/reference.js` | Sprite reference candidate rendering and provenance. |
| `deckRender.js` | Deck card image render jobs. |
| `fableLoom/production.js` | FableLoom production render planning and enqueueing. |
| `appProcessTypes.js` | Dependency-free managed-app process-type vocabulary and PM2/desktop predicates. |
| `appProcessStatus.js` | PM2-backed managed-app status projections, expected-exit policy, and custom PM2 home resolution. |
