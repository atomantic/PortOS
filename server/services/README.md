# Server Services

Domain services own multi-step workflows over models, settings, and shared
infrastructure. Import the narrow service module needed by a caller; the
image-generation paths below are useful entry points when tracing render jobs.

| Module | Responsibility |
| --- | --- |
| `spawnBudgetProof.js` | Server-owned retry-episode and latest-dispatch proof validation, including counter round trips. |
| `spawnBudgetReconciliation.js` | Ownership-fenced monotone correction of a stopped task from its exact latest dispatch receipt; correction remains held. |
| `explicitSpawnBudgetReset.js` | Resolves a unique stopped orphan and its retained checkout before an explicit reset-and-run action. |
| `catalogPrimitives.js` | Explicit creative primitive ownership, safe universe membership, independent forks and durable retry receipts. |
| `catalogDB/ingredients.js` | Canonical ingredient CRUD/history, atomic flag-only locks and bounded requested-ID card projections with batched cover/ownership/identity context. |
| `catalogDB/media.js` | Ingredient media associations, metadata-free profile covers (`getIngredientMediaCover`), image-owner lookup by media key (`findMediaOwnersByKeys`) and integrity checks that can reuse already-read media rows. |
| `catalogPrimitiveUsage.js` | Indexed/derived creative usage aggregation and exact canon-pointer removal guards for FableLoom and local voice profiles. |
| `deadOwnerReservations.js` | Boot and orphan-sweep reconcile for reservations whose admitting process died: stamps settled Output publication rows unsettled for receipt recovery, and releases only cli-run or mind-turn residue whose owning record proves completion. |
| `branchReconcileRetirement.js` | Retires exact-head, integrated checkouts through fresh fenced archive proof; reserves bounded cognitive review only for source/history differences. |
| `repoCleanupRecovery.js` | Reserves one bounded exact-owner review or code-repair obligation, rechecks policy and delivery evidence before publication, and never queues a provider for routine holds. |
| `repoCleanupObservation.js` | Read-only exact-ref presence/absence accounting; malformed, changing or unsupported metadata remains unknown. |
| `branchReconcileCompletion.js` | Runs ownership-checked merged and superseded cleanup on coordinator completion, independent of perpetual scheduling. |
| `heldCheckoutReview.js` | Selects the merged PR for an exact local head and computes fresh forge identity, merged PR/default refs and exact code comparisons for a digest-bound operator retirement; no saved consent or policy rewrites. |
| `heldCheckoutRecovery.js` | Prepares scoped retirement reviews that fingerprint checkout content, empty gitlinks and private Git administration (never archived; a PR merged at the exact head makes local files disposable) before ownership-checked removal and expected-head local ref deletion; reads historical checkout archives for compatibility. Pending-merge receipts use `retirePendingMergeCheckout`, which independently verifies the merged head and refuses locks, supersession and initialized submodules. |
| `cosClaimOwnershipState.js` | Shared ownership lock, per-checkout retirement fence with `retireWithUnlockedArchive` (archives run between two lock sections), and fail-closed live-agent reader used by claim binding and worktree cleanup. Re-exported by `cosClaimOwnership.js` for existing callers; does not import reconciliation. |
| `systemActivityNotify.js` | Coalesced activity invalidation signal and LLM lifecycle adapters; producers do not import media execution. |
| `systemActivityWatchers.js` | Socket initialization arms media and CoS activity subscriptions here, sharing the notification signal without pulling boot observers into producers. |
| `branchCompletionPolicy.js` | Retains explicit registered PR completion policy through agent archives. `readBranchCompletionHold` gates reconciliation by exact repository/branch/PR identity; human handoffs and configured review stay held, explicit releases require a fresh matching forge head, and verified merged retirement is a separate action. |
| `databaseCutoverHandshake.js` | Narrow fenced-boot path for the ordinary server: at `verifying`/`verified` prove this process's own pool reaches the recorded target, publish a per-pid proof, and wait for admission release before the app graph loads. |
| `databaseMaintenanceCutover.js` | Internal cutover worker body (transfer → forward-only `.env` mode commit → server restart with target proof → release → CoS restart) and `recoverDatabaseCutover(id)` same-operation recovery for the CLI/API. |
| `databaseMaintenanceProducers.js` | Internal one-use coordinator stage: retain producer identity, stop this install's PM2 CoS/server, and verify fresh readback while admission remains fenced. |
| `databaseMaintenanceQuiescence.js` | Internal coordinator stage after producer shutdown: terminate verified running detached-writer groups, prove every registry record quiescent from process-table evidence, archive it with the operation, and refuse pending, legacy, orphaned, ambiguous or unregistered writers. |
| `gmailApi.js` | Six-operation Gmail v1 adapter (`createGmailApi(auth)`) over the shared OAuth client's `request()`: fixed origin, encoded IDs, URLSearchParams queries, explicit JSON bodies, capped 30s request timeout and no automatic send retries. Auth, refresh and transport stay in `googleAuth.js`. |
| `imageGen/prepareParams.js` | Shared image request preparation and the canonical local image model selector. Use `selectLocalImageModelFromSettings()` for model identity and `resolveLocalImageModel()` when the caller must also enforce local runtime, hardware, and edit-image requirements. |
| `musicVideo/renderCleanupActivity.js` | Synchronous per-project admission between render retirement, shot renders, previews and publishing-kit preparation. |
| `musicVideo/renderCleanup.js` | Derived-render inventory and cleanup, preserving current finals, saved references, source takes and comparison looks; serializes retirement with project and history writers. |
| `musicVideo/renderCancellation.js` | Shared capture-abort and ffmpeg kill selection for full/excerpt renders; records explicit cancellation before signaling and classifies nonzero closes without releasing ownership. |
| `musicVideo/sharingCopy.js` | Source-hashed private sharing MP4s: queued 720p H.264/AAC export, strict decimal 100 MB cap, supervised cancellation, verified download and owned-file cleanup. |
| `mediaJobQueue/index.js` | Owns admission, lanes, durability and terminal effects; boot passes `deferCompletionRecovery` to `initMediaJobQueue()` and calls `resumeMediaJobCompletions()` after completion hooks are registered; `videoHolds.js` returns local-video cohort preparation results and owns circuit breakers, `recoverySettlement.js` names the transient recovery evidence and the maintenance-permit release decision, while `videoGen/modelSelection.js` owns model-selection policy. |
| `imageGen/index.js` | Mode-aware image backend execution dispatcher. Preparation uses `lib/imageCleanDefaults.js` for cleaner policy and resolves local model identity before enqueueing. |
| `dockerEngine.js` | Shared Docker discovery (#12844): `resolveDockerCli` (PATH, then the Docker Desktop bundle), `probeDocker`, and `resolveDockerEngine` — prefers a running Docker Desktop, falls back to native Docker Engine, refuses `tcp://`/`ssh://` endpoints, requires Linux containers and pins the chosen context. Never starts or installs Docker. |
| `dockerContainment.js` | Docker containment executor (#12844): `runContained` (install/validate over a worktree, serialized per worktree, wall-time kill-and-remove, tracked-file patch, refuses with `CONTAINMENT_UNAVAILABLE` instead of ever running on the host), status, explicit image pull, orphan sweep and `reconcileDockerContainment` for the feature toggle. |
| `superColliderRuntime.js` | Managed SuperCollider runtime I/O (#9412): Docker probe, recipe-hash-stamped image build, `runSuperColliderContainer` (contained `sclang` run with forced container removal), the synthetic render probe and its cached evidence, `getSuperColliderStatus` and idempotent `setupSuperColliderRuntime`. Never runs at boot. |
| `superColliderRender.js` | Contained SuperCollider renders (#9413): media-queue `supercollider` jobs that snapshot source into a job-private dir, run the trusted NRT wrapper via `runSuperColliderContainer` (output quota, timeout, cancel → container force-removed), validate the decoded WAV and publish a 24 h preview + provenance sidecar (`readSuperColliderPreview`). Sweeps orphaned containers/scratch before each render. |
| `universeBuilderRender.js` | Universe Builder batch render jobs. |
| `pipeline/visualStageHelpers.js` | Shared pipeline visual prompt, LoRA compatibility, and image-job enqueue helpers. |
| `creativeStyleSources.js` | Resolves a universe style guide or mood board into art-direction text plus local reference images; shared by Code Animation and Creative Commissions. |
| `creativeDirector/firstPassGen.js` | Gracefully gated first-pass portraits and scene frames. |
| `universeCharacterSheet.js` | Character reference-sheet render and completion workflow. |
| `loraDatasetGenerate.js` | Training-image render and dataset lifecycle. |
| `dataMaintenance.js` | Allowlisted retired-data inventory, expiring previews and explicit serialized removal with active-work refusal. |
| `sprites/reference.js` | Sprite reference candidate rendering and provenance. |
| `deckRender.js` | Deck card image render jobs. |
| `fableLoom/production.js` | FableLoom production render planning and enqueueing. |
| `appProcessTypes.js` | Dependency-free managed-app process-type vocabulary and PM2/desktop predicates. |
| `appProcessStatus.js` | PM2-backed managed-app status projections, expected-exit policy, and custom PM2 home resolution. |
| `forkReviewMergeTarget.js` | Captures a fresh fork review target from the base repository’s live PR; admission verifies the registered target, live task, exact checkout head, fork remote/upstream and live forge identity. |

| `providerExecutionOptions.js` | Explicit source-linked execution selection creation; compatibility exports for capability inspection and dispatch preparation. |
