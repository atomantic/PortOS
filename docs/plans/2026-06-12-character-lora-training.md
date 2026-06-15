# Character LoRA Training — Create > Image Gen ↔ Universe/Character/Catalog

## Context

PortOS can render characters (mflux FLUX.1 + FLUX.2/diffusers + Codex) and already manages LoRAs for inference (`data/loras/` + `.metadata.json` sidecars, Civitai trigger words, 8-LoRA stacking, compat-key gating), and characters already have rich visual canon (25+ descriptor fields, reference-sheet turnarounds in `data/image-refs/`). What's missing is the loop closer: build a training dataset from a character's reference material, train a LoRA locally, and have that LoRA automatically applied whenever the character is rendered — giving consistent character design, outfits, and props across Image Gen and the comic pipeline.

**User decisions:** pluggable runtime (mflux FLUX.1 + diffusers/peft FLUX.2 in one PR); dataset builder = generate + upload + caption-edit; auto-caption via vision LLM; trained LoRA links to character AND auto-applies in pipeline renders.

**Federation decision:** datasets and character→LoRA links are **machine-local** (like `data/loras/` itself). No pointer is stamped onto the federating character/universe record — resolution is always a local sidecar scan, so peers without the weights gracefully see no link. No `schemaVersions.js` bump anywhere.

## Part A — Dataset builder (character → training-ready dataset)

### Data model — `data/lora-datasets/<id>/` via `createCollectionStore` (file-primary, machine-local; add STORAGE.md row)

```json
{ "schemaVersion": 1, "id": "uuid",
  "character": { "entryId": "<universe entry id>", "ingredientId": "<catalog id|null>", "universeId": "...", "name": "..." },
  "triggerWord": "kessa_brightwater", "status": "draft|training|trained",
  "images": [{ "id": "img-uuid", "file": "img-uuid.png", "caption": "kessa_brightwater, ...",
               "captionSource": "vision|manual|null", "source": "generated|upload|refsheet-slice",
               "sourceJobId": null, "variation": { "view": "...", "pose": "...", "expression": "...", "outfit": "..." },
               "status": "rendering|ready|failed", "width": 1024, "height": 1024 }],
  "training": { "lastJobId": null, "loraFilename": null, "completedAt": null } }
```

Characters carry two ids (`entry.id` per-universe + `ingredientId` catalog row) — store both; all resolution matches either. Image bytes live at `images/<imageId>.png` (sharp-normalized PNG). One dataset per character (find-or-create on `(universeId, entryId)`). **No backup exclude** — uploads + curation are not re-creatable. Add `PATHS.loraDatasets` to `server/lib/fileUtils.js`; register store with the boot verifier in `server/index.js`.

### New server modules (each barrel-exported + README row)

1. **`server/lib/loraDataset.js`** (pure): `sanitizeLoraDataset`, `deriveTriggerWord(name, {taken})` (slug + collision suffix), `prefixCaption(triggerWord, text)` (idempotent), `buildVariationMatrix(character, opts)` (deterministic round-robin over views × poses × `character.expressions` × `character.wardrobes`, with fallbacks), `buildDatasetImagePrompt(universe, character, variation)` — style clause (`buildStyleClause` from `universeCanon.js`) + identity block (export `extractCharacterPromptCommon` from `universeCharacterSheet.js` — one-line change) + solo-subject/plain-background/negative-prompt clauses.
2. **`server/services/loraDatasets.js`**: collectionStore CRUD, `addUploadedImage` (sharp→PNG), `updateImageCaption`, `deleteImage`, `reconcileRenderingImages` (read-time healer: look up `sourceJobId` in the media-job archive; completed→copy+ready, failed/missing→failed — covers restarts).
3. **`server/services/loraDatasetGenerate.js`**: `generateDatasetImages(datasetId, opts)` — per variation: append `status:'rendering'` entry, build params like `renderCharacterReferenceSheet` does (`resolveSheetModelId`, codex/local mode, `cleanC2PA:true`, 1024×1024), `enqueueJob({kind:'image'})`, subscribe via the `sheetSubscribers` single-dispatcher pattern (`universeCharacterSheet.js:357-372`), on complete copy from `data/images/` into the dataset and flip status inside the per-id write queue. `sliceReferenceSheet(datasetId, {variant, cols, rows})` — sharp grid-crop of the existing turnaround (`readSheetPointer` from `server/lib/storyBible.js`); v1 = fixed grid + user prunes bad crops (auto panel detection deferred — layouts are model-generated/non-deterministic).
4. **`server/services/loraDatasetCaption.js`**: `startCaptionRun(datasetId, {imageIds?, providerId?, model?, overwrite})` → sequential loop, reuse `describeImageDataUrl` from `server/services/visionTest.js:226` (provider: request → `settings.loraTraining.captionProviderId` → `'lmstudio'`), `prefixCaption`, persist, SSE progress via `server/lib/sseUtils.js`. Loop body wrapped in try/catch (outside request lifecycle).
5. **`server/services/characterLoraResolver.js`**: `resolveCharacterLoras(matchedCharacters, {compatKey, max=3})` + `findLorasByCharacter({entryId, ingredientId})` — scan `listLoras()` sidecars for `character` match, filter by compat key, cap at 3 (room under MAX_LORAS=8). Missing file ⇒ no match (inherent peer grace).

### Routes — `server/routes/loraDatasets.js` (`/api/lora-datasets`), Zod-validated; static mount `/data/lora-datasets`

CRUD; `POST /:id/images` (multipart via `server/lib/multipart.js` `uploadFields`, 25MB, image mimetypes); `POST /:id/generate` (count 1–40 + variation overrides + modelId/mode); `POST /:id/slice-reference-sheet`; `POST /:id/caption` → `{runId}` + `GET /:id/caption-runs/:runId/events` SSE; `PATCH /:id/images/:imageId` (caption); `POST /:id/train` (validates readiness ≥10 ready+captioned images, then hands off to Part B). Plus `GET /api/loras/by-character?entryId=&ingredientId=` in `server/routes/loras.js` (registered ABOVE `GET /:filename`).

Settings slice: `loraTraining: { captionProviderId, captionModel, defaults: { steps, rank, learningRate, resolution, checkpointEvery, sampleEvery } }` — Zod schema in `server/lib/validation.js`, wired into `PUT /api/settings` via the `backupConfigSchema.partial()` pattern.

## Part B — Training engine

### Service — `server/services/loraTraining/` (index.js, events.js, runtimes.js, progress.js, sidecar.js, dataset.js, failure.js, db.js)

- `resolveTrainingRuntime(baseModelId)` via `getImageModels()`: `runner==='flux2'`→`'flux2'`; mflux family (`dev`/`schnell`)→`'mflux'`; else 400. Diffusers families (z-image/qwen/etc.) out of scope.
- `runTraining({...params, jobId})` mirrors `videoGen/local.js#generateVideo`: spawn venv python with `PYTHONUNBUFFERED`, `safeChildProcessEnv(hfTokenEnv())`, caffeinate on darwin, stdout line protocol → `trainingEvents` → SSE; `cancel(jobId)` = SIGTERM → 8s SIGKILL escalation. `classifyTrainingFailure` regexes stderr tail (OOM / MODULE_NOT_FOUND / USER_ERROR / HF_AUTH).

### Python trainers (`scripts/`)

- **`scripts/train_mflux_lora.py`** — wrapper that subprocesses mflux's own training CLI (`python -m mflux.dreambooth --train-config <json>`; fallback `mflux-train`) in the existing `~/.portos/venv`; Node-side `buildMfluxTrainConfig()` writes the config JSON (model/steps/lora_layers/examples with per-image prompts). Wrapper translates output to `STAGE:`/`STEP:<cur>:<total>:<loss>`/`CHECKPOINT:`/result-JSON protocol, reuses `scripts/_runner_common.py` heartbeat, forwards SIGTERM. **NEEDS-VERIFICATION**: exact mflux training entrypoint/config keys for the installed version (venv absent on this machine — verify via `setup-image-video.sh` then `--help` + site-packages read; pin mflux if its training surface churns).
- **`scripts/train_flux2_lora.py`** — vendored diffusers/peft trainer in `~/.portos/venv-flux2` (torch 2.11 + diffusers-git + peft 0.19 already installed — **no new venv, no new pips**). Two phases: `STAGE:precompute-latents` (encode all images+captions once, cache, free VAE/text-encoder — the make-or-break MPS memory move) then `STAGE:training` (transformer-only bf16, LoraConfig rank r on attn projections, grad checkpointing, AdamW, flow-matching loss). `CHECKPOINT:` every N steps via `save_lora_weights`; `SAMPLE:` images flow through the existing `preview` SSE type; SIGTERM → checkpoint-then-exit-143. Train against **bf16 repos only** (never SDNQ/int8); trained LoRA still loads on quantized inference of the same size variant.

### mediaJobQueue integration (`server/services/mediaJobQueue/index.js`)

`JOB_KINDS` → `['video','image','training']` (line 103); dispatch/emitter/runJob branches at the verified seams (110, 687, 760); `WATCHDOG_TRAINING_MS` = idle-based 30min (STEP lines + heartbeats reset it); GPU lane (serialized with renders — correct, shared Metal); progress % from step/totalSteps; cancel + boot-orphan handling already work via existing machinery; `PARAM_ALLOWLIST` in `routes/mediaJobs.js` gains training fields so the Render Queue labels rows.

### Run persistence — Postgres `lora_training_runs` (db-primary per STORAGE.md; `creative_director_projects` adapter precedent)

`id/status/character_id/timestamps + data JSONB` (runtime, baseModelId, datasetId, triggerWord, params, progress, artifacts, output, error), added idempotently to `server/scripts/init-db.sql`. Progress DB writes debounced ~2s (SSE is the live channel). Artifacts on disk at `data/training-runs/<runId>/{checkpoints,samples,cache}`; backup excludes (rsync-anchored): `/training-runs/*/checkpoints/` (overridable) + `/training-runs/*/cache/` (not overridable).

### Routes — `server/routes/loraTraining.js` (`/api/lora-training`)

`POST /runs` (validate dataset ready + runtime health gate: mflux probe / `isFlux2VenvHealthy()` → 412), `GET /runs`, `GET /runs/:id`, `GET /runs/:id/events` (→ `attachSseClient(run.jobId)`), `POST /runs/:id/cancel`, `DELETE /runs/:id` (409 while active; optional `?deleteLora=true`), `GET /runs/:id/samples/:filename` (assertSafeFilename), `GET /status` (runtime readiness + defaults + memory expectations). `startTrainingRunSchema` + `loraTrainingSettingsSchema` in `server/lib/validation.js` (trigger word `^[a-zA-Z0-9_-]+$`).

### Trained-LoRA registration — `buildTrainedSidecar()`

Copy adapter → `data/loras/lora-trained-<slug>-<runId8>.safetensors` + sidecar: `source:'trained'`, `character` block (entryId+ingredientId+universeId+name), `datasetId`, `runId`, `triggerWords:[triggerWord]`, `runnerFamily` (`mflux`|`flux2`) + `fluxVariant` (4b/9b) so `composeCompatKey` gates it to the right base models in the existing picker **with zero picker changes**, `training` params block, `previewImageUrl` → last sample. Small `loras.js` edit: pass `source`/`character`/`trainedFromDatasetId` through `listLoras()` mapEntry.

## Part C — Client UI + auto-apply

### Pages (deep-linkable, plain-scroll, mobile-responsive)

- `client/src/pages/LoraTraining.jsx` → `/media/training` — dataset cards (character, thumb strip, counts, status chip, trained badge) + new-dataset character picker.
- `client/src/pages/LoraDatasetDetail.jsx` → `/media/training/:datasetId` — workbench: header (trigger-word inline edit, readiness summary), action bar (Generate dialog / Upload / Slice sheet / Caption all with `useSseProgress` / Train), `DatasetImageGrid` (caption textarea blur-save, source badges, per-image rendering spinner, re-caption, delete with inline confirm), `TrainingLaunchPanel` (params form gated on readiness + no in-flight save; run progress via SSE; cancel).
- New components under `client/src/components/loraTraining/`; API wrapper `client/src/services/apiLoraTraining.js` (barrel + README).
- `NAV_COMMANDS` entry `nav.media.training` (`/media/training`, section Create, aliases: training/lora-training/train-lora/datasets) + alphabetical sidebar link in `Layout.jsx` + Routes in `App.jsx`.

### Auto-apply (pipeline renders)

- `server/services/pipeline/visualStages.js`: after character matching (comic pages + storyboards, local mode only), `resolveCharacterLoras(matched, {compatKey: <selected model's loraCompatKey>})` → pass `loraFilenames`/`loraScales` into `enqueueImageJob` baseParams (seam at line 154 — currently passes none); codex mode skips with one log line. Trigger word woven into the Featuring fragment in `composeComicPagePrompt` via a `loraByCharacterId` map param (compose stays pure).
- Per-render opt-out: `applyCharacterLoras` boolean (default true) on `comicPageRenderSchema` + storyboard schema + checkbox in `PipelineIssue.jsx` render controls.

### Character surfacing

- `CanonCard.jsx` (universe editor): `CharacterLoraChip` (lazy resolve via `/api/loras/by-character`, `{silent:true}`) + "Dataset" button (find-or-create → navigate) + "training…" chip while active.
- `CatalogIngredient.jsx`: `TrainedLoraPanel` beside `ReferenceSheetPanel` (resolves via ingredientId).
- `Loras.jsx`: "Character: <name>" chip on trained LoRAs linking to the dataset.

## Build order

1. `lib/loraDataset.js` + tests; export `extractCharacterPromptCommon`; `PATHS.loraDatasets`; STORAGE.md row.
2. `services/loraDatasets.js` + routes + static mount; upload + refsheet slicing.
3. Generation batch (enqueue→subscribe→copy) + reconcile healer.
4. Captioning service + settings slice + SSE.
5. Training engine: runtimes/progress/sidecar/failure pure modules + tests → python trainers (verify mflux surface first) → mediaJobQueue kind → db adapter + init-db.sql → routes → backup excludes.
6. Client: api wrapper → pages → components → nav/sidebar/routes.
7. Resolver + pipeline auto-apply + opt-out toggle; character/catalog/LoRA-library surfacing.
8. Changelog in `.changelog/NEXT.md`; `/simplify` pass.

## Tests (vitest, beside source — pure-logic-first per repo convention)

`loraDataset.test.js` (sanitizer, trigger-word slug/collision, caption prefix idempotence, variation matrix determinism, prompt builder clauses); `loraTraining/runtimes.test.js` (arg/config builders, runtime resolution, bf16-repo enforcement); `progress.test.js` (STEP/CHECKPOINT/SAMPLE/USER_ERROR/result-JSON parsing); `sidecar.test.js` (parity with Civitai sidecar fields, compat keys); `failure.test.js`; `dataset.test.js` (readiness validation); `db.test.js` (mock-pg); `characterLoraResolver.test.js` (entryId/ingredientId match, compat filter, cap, missing-file grace); route tests (Zod rejections, multipart, 412 venv-missing, cancel mapping); `visualStages.test.js` additions (lora passthrough local-only, opt-out, trigger word in prompt); nav-manifest + barrel tests auto-cover new entries.

## Verification (end-to-end on Apple Silicon)

1. `cd server && npm test` (all suites).
2. Create a character in a universe → "Dataset" from its card → generate 12 reference images (watch them stream in via the image queue) → upload 2 → slice the reference sheet → "Caption all" (SSE progress, captions land trigger-word-prefixed, edit one).
3. Train with `steps:20, checkpointEvery:10, sampleEvery:10` on mflux/dev: watch STEP progress + sample preview frames in the run panel; cancel mid-run → assert checkpoint saved + `canceled` state; re-run to completion.
4. Assert: LoRA + sidecar in `data/loras/`, visible in `/media/loras` with correct compat badge + character chip; manual render in `/media/image` with the LoRA + trigger word works.
5. Render a comic page featuring the character → confirm `loraFilenames` in the job params + trigger word in the prompt; toggle `applyCharacterLoras` off → confirm absent.
6. Repeat step 3–4 once on flux2 (klein bf16) to validate the second runtime.

## NEEDS-VERIFICATION ledger (resolve during implementation)

- mflux training entrypoint/config schema + native output format (venv absent here; verify via `--help` + site-packages, run a 10-step smoke before finalizing the wrapper regexes; pin mflux version if needed).
- Whether diffusers-git already ships a FLUX.2 dreambooth-lora example to vendor/trim vs adapting the FLUX.1 script; `Flux2KleinPipeline.save_lora_weights`/`load_lora_weights` round-trip.
- bf16 4B repo existence (`black-forest-labs/FLUX.2-klein-4B`); fall back to 9B bf16 (64GB floor) if only quantized 4B exists.
- bf16-trained LoRA applying cleanly on SDNQ-quantized inference (`scripts/lora_utils.py` logs-and-continues — watch for silent skip).
- Exact exported job-archive getter name in mediaJobQueue for the reconcile healer; where pipeline resolves modelId → `loraCompatKey` (fallback: no compat filter in v1).
- Whether `docs/BACKUP.md` inventories paths (add dataset row if so).
