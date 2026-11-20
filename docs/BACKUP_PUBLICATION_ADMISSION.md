# Shared backup publication admission

The server and `portos-cos` are separate processes that share one install data
root. `withBackupAssetPublication` registers a short durable lease in
`data/backup-admission/publications/` before changing an asset and its owning
record. Model execution and transfers into unreferenced staging files remain
outside the lease. Hold it through the final record write and failure rollback.
Nested calls reuse the existing lease. Synchronous completion listeners receive
separate leases while their parent remains admitted.

A snapshot or live restore atomically creates `data/backup-admission/cut/`, then
drains every registered publication before reading or replacing either store.
New publications wait until the cut owner releases it, for at most two minutes
by default (`withBackupAssetPublication(work, { timeoutMs })` can set a shorter
caller deadline). Expiry rejects with `BACKUP_SNAPSHOT_BUSY`, the cut ownership
and recovery path; no publication callback runs and the cut remains intact. Readers register before
checking the cut; the cut registers before checking readers. This ordering closes
the cross-process admission race. A preliminary gate check avoids registering
and deleting leases repeatedly during a long snapshot. Directory creation and
removal work on Windows and POSIX; ownership files are fsynced, with directory
fsync on POSIX (Windows does not support opening a directory that way). The
directory-sync capability follows the native host OS associated with the filesystem;
a simulated product platform must not change durability behavior.

If a publication cannot restore its previous pair, throw an error with
`backupPublicationUncertain: true`. The boundary settles its local callback count
but retains the durable owner with an uncertainty marker. Even a nested failure
caught by its caller retains this blocker; ordinary errors after successful
rollback release admission normally. The next snapshot refuses until recovery.

Every owner records a random ID, generation, PID, OS process start, kind, and
timestamp; only the matching owner may release its directory, and age never does.
At cut time (#16388) a plain publication lease is retired when its PID is gone or
was reused by a process with another start time (a lease without a recorded start
needs a dead PID). `uncertain`, unreadable, live and cut/restore owners are never
retired automatically. The cut logs one `⏭️` line and records `reclaimedLeases` in
the manifest's `assetConsistency`. A cut that cannot drain refuses with
`BACKUP_SNAPSHOT_BUSY`, naming each blocking path and the recovery section below;
the Backup tab shows it. `backupPublicationAdmissionStatus()` reads all ownership.

The control directory is machine-local authority. Backup excludes it
unconditionally, and all full or selective restores preserve it. Upgrade and
restart both the server and CoS runner before relying on coordination between
them; an older runner does not participate. Admission still only covers owners
listed as admitted in the backup inventory, not arbitrary shell commands or
external tools that write the data tree.

## Interrupted ownership recovery

A blocking owner (`uncertain`, unreadable, running, or a cut/restore) is a
recovery blocker, not evidence that its data is safe. Keep its ID, PID, generation,
timestamp, and directory path in the incident record. Stop both PortOS processes
and any tool writing the affected data, correlate the owner with logs, inspect the
file/record pair, and finish or roll back that domain's interrupted publication.
For a restore, also complete its cache/index and database recovery before
reopening admission. A failed snapshot stays failed.

Only after the data is verified may an operator retire that exact ownership
directory while all writers remain stopped. Preserve its owner record with the
recovery evidence; do not delete the control tree, clear an `uncertain` or
cut/restore owner merely because its PID exited, or remove a record from a running
process. Then restart both processes. If the record is unreadable or the data
cannot be established, retain the blocker and restore from a verified source.

## Consistency while assets are changing

Reviewed image-edit inputs use a same-directory hard link as an ownership anchor.
Queued inputs made before this anchor existed, and restored inputs whose recorded
filesystem identity or anchor no longer matches, fail closed with a request to
review again; their files are retained for inspection. Filesystems that cannot
create the link reject staging rather than enqueueing an unanchored job. A backup
or restore need not preserve inode numbers or hard links, so do not expect queued
reviewed edits to replay after restore. Older PortOS versions do not enforce the
anchor contract; drain these jobs before downgrading. An interrupted collection
may leave a deletion intent and private quarantine directory for manual inspection;
the manifest records that directory. A replacement found during collection is
retained there rather than restored over another file.

The backup service closes a shared cross-process publication boundary before copying
`data/`, drains music-track take publications already in progress, and keeps
new take publications waiting through the SQL dump and manifest write. Browser
code takes, SuperCollider takes, chiptune renders, and painted-waveform renders
stage encoding outside that boundary, then publish their final audio bytes and
track row together inside it. Manual and scheduled backups use the same cut.
If an admitted take does not drain within two minutes, or the cut cannot be
released, the snapshot is marked failed (never published or used for retention
pruning). A normal drain timeout releases its own cut; an unreadable or interrupted
owner remains blocked until its data is reconciled. The protocol and deliberate
recovery procedure are documented in [Shared publication admission](./BACKUP_PUBLICATION_ADMISSION.md).

**Media-job completion (#9981).** A render's completion holds the same admission
from staging its terminal queue row (`media-jobs.json`) through the `completed`
event fan-out; it is never held while rendering, waiting in the queue, calling a
provider, or for failure and cancellation outcomes. Each attach hook that names
the render's file in a row takes its own admission synchronously inside that
fan-out, so a cut already waiting to drain still waits for it. A completion that
arrives during the cut leaves the job `running` in the queue snapshot (the
finished file is an unreferenced extra, never a dangling reference) and
publishes once the cut releases; the lane stays occupied meanwhile, but the
renderer is not stopped and cancellation is unchanged. A terminal write that
fails inside the admission is retried inside it and releases it when it gives
up. Only a queue snapshot written inside an admission lease commits a staged
completion: once storage recovers, an unrelated queue write (progress, a new
job, the shutdown flush) keeps that job `running` on disk and hands it to a
recovery commit that takes its own lease, waiting out any open cut, so the
terminal row and its attach hooks still publish together.

Database maintenance shares the same boundary and never terminates a render or
stops PM2 to obtain it:

- **A database restore (execution only; preview takes no cut)** acquires the cut before
  it publishes its recovery journal. Admitted file-plus-row publications drain
  completely first, so the replay never lands under a half-published pair. If a
  backup owns the cut, or a publication does not drain within two minutes, the
  restore returns `backup_snapshot_busy` without changing anything.
- **Accepting a backend cutover** takes the cut around publishing the maintenance
  fence (it waits up to 30 seconds to drain, and refuses with
  `DATABASE_PREFLIGHT_BUSY` while a backup owns it). The fence is published
  before any new publication can be admitted, and every admitted one has already
  finished. Once it exists, a backup refuses to start or to take its cut
  (`DATABASE_MAINTENANCE`) — one that already reserved a snapshot marks it failed
  and preserves older recovery points — and ordinary database writes are
  refused, so no row can reference a file the fence stranded. Cancelling the
  operation reopens everything; nothing stays held.
- Every release is owner-scoped: a failed or cancelled operation releases only the
  cut it acquired and leaves the maintenance journal and restore-recovery
  incomplete guards exactly as they were. Durable ownership coordinates the
  server and CoS runner sharing this install. Both processes must run the updated
  protocol; the detached cutover worker still runs only after the server stops.

Admission inventory (`withBackupAssetPublication`):

| Owner | Status |
| --- | --- |
| Music Designer take publication (`musicTakePublication.js`) | Covered (#9980) |
| Media-job completion: queue terminal row + `completed` fan-out (`mediaJobQueue/persistence.js`) | Covered |
| Attach hooks on `completed` via `mediaJobImageHook.js` (writers-room, catalog, music-video scene image/video/cast-sets, CD scene image/music bed, FableLoom scene image/video, sprite references, deck cards, music studio) | Covered |
| Pipeline filename hooks (`filenameHookFactory.js` comic pages and storyboards, `seasonCoverFilenameHook.js`) | Covered |
| Recovery commit of a completion whose terminal write failed (`mediaJobQueue/persistence.js`) | Covered: only an admitted snapshot commits it (#9982) |
| Universe Builder completion listeners: collection filing, canon entry-ref append, and sidecar enrichment (`universeBuilderCollectionHook.js`); character reference sheet copy and pointer stamp (`universeCharacterSheet.js`) | Covered (#9982) |
| Creative Director evaluation frames: render-completion sampling (`creativeDirector/sceneRunner.js`) and the resume pass that re-samples missing frames in place (`creativeDirector/completionHook.js`) | Covered from the first `${jobId}-fN.jpg` write through the scene row that names them (#9982) |
| Creative Director render settlement (scene status and auto-accept, plan-step settle, seed-frame wait) and Music Video production step settlement (`musicVideo/productionService.js`) | Reference-only: these write no bytes, and the render they name was on disk before its admitted completion published |
| Sprite animation completion: clip copy, frame packaging and run record (`sprites/localAnimationJobHook.js`) | Covered from clip staging through the run record that names the packaged frames (#9982) |
| Sprite reference lock and unlock, walk set finalization, unlock, reopen and anchor/turnaround revision, source-pipeline import, and the grok-TUI attach lanes for walk and named tracks (`sprites/reference.js`, `sprites/walk.js`, `sprites/importer.js`, `sprites/animationTrackWorkflow.js`) | Covered (#9982): each holds one lease from its first byte through the sprite row it pairs with (or, for the attach lanes, the run record naming the packaged frames) |
| Sprite generation starts, reference uploads, candidate and run records, selections, loop trims, atlas compile, publication history, asset deletion and the publish-binding row (`sprites/walkTrims.js`, `atlas.js`, `assets.js`, `publish.js`, and the non-lock paths of `reference.js`, `walk.js`, `animationTrackWorkflow.js`) | Covered (#9982): shared animation/reference queues acquire admission before serialization; file-primary records and their bytes must drain together, regardless of the metadata-only sprite DB row |
| Direct gallery upload, image prompt/visibility sidecar replacement, and image deletion (`imageGen/local.js`) | Covered as one file/sidecar/index workflow (#9982) |
| Gallery image deletion's universe canon purge (`galleryImageDeletion.js`) and character reference sheet deletion (`universeCharacterSheet.js`) | Covered from file removal through the universe pointer purge (#9982) |
| Video-history deletion, including downloaded-video deletion (`videoGen/historyOps.js`) | Covered through file/history/index removal (#9982) |
| Gallery video upload, download finalization and poster edits (`videoUpload.js`, `videoDownload.js`, `videoGen/poster.js`) | Covered (#9982): uploads lease byte installation through history and rollback; downloads lease poster creation through history and rollback after yt-dlp finishes; poster edits lease creation, history and cleanup |
| Retained LoRA dataset record edits from the surviving-trainer observer (`loraDatasets.js`) | Covered through the record commit (#9982); dataset uploads, crops and deletion are retired |
| Voice Studio audition and character assignment (`voice/studio.js`) | Covered from source-file write/copy through profile-row commit and failed-write cleanup (#9982) |
| Music Video development artifact import/generated save and vocal-stem attachment (`musicVideo/devArtifactService.js`, `musicVideo/vocalStem.js`) | Covered from final file copy/write through project-record commit and failed-write cleanup (#9982) |
| Music-library upload copy and deletion (`pipeline/musicLibrary.js`) | Covered (#9982): the copy and the unlink each hold one lease; the delete route intentionally leaves existing issue/project references to the removed file |
| Voice benchmark audio and row (`voice/profileBenchmarks.js`), cloned-candidate recording and row (`voice/profiles.js`), and the fine-tune job record that names each sealed checkpoint (`voice/fineTuning.js`) | Covered (#9982); promoting a checkpoint writes only a row naming bytes the job record already named |
| Pipeline audio stage rows: generated music, cue render and voice-over line render (`routes/pipeline/audio.js`) | Covered (#9982): the row that first names the WAV takes the lease; the sidecar or synthesizer writes the WAV before it |
| Music-library upload attach: Music Designer upload, pipeline music upload, YouTube import and Suno import (`routes/tracks.js`, `routes/pipeline/audio.js`, `trackYoutubeImport.js`, `trackSunoImport.js`) | Reference-only: the admitted library import copies the file first and the track or issue row commits after it |
| LoRA training and deployed LoRAs: trained-adapter registration, checkpoint promotion over the deployed adapter, the promoted-checkpoint preview copy, the progress row naming trainer-written samples and checkpoints, run deletion, and LoRA deletion from the LoRA manager or Media Models (`loraTraining/index.js`, `loras.js`) | Covered (#9982): registration and promotion hold one lease from the adapter write through the run row and dataset flag; Civitai and Hugging Face installs admit the sidecar that first names the already-linked weights |
| Music Video final and excerpt renders, publishing-kit builds and composition document versions (`musicVideo/render.js`, `musicVideo/excerptRender.js`, `musicVideo/publishKit.js`, `musicVideo/compositionDocument.js`) | Covered (#9982): the encoder or import writes the files in place; the history entry and project row that first name them commit under one lease |
| Music Video excerpt deletion (`musicVideo/excerptService.js`) | Reference-only: the project row drops the excerpt before its unreferenced video and contact sheet are unlinked |
| Music Video performance repair, MIDI transcription and the autonomous Suno song (`musicVideo/performanceRepair.js`, `audioMidiTranscription.js`, `musicVideo/autonomous/autonomousStages.js`) | Covered (#9982): the boundary frame or `.mid` is written first; the row that first names it (repair revision, project MIDI pointer, track render) commits under one lease, and a declined MIDI result is unlinked inside it |
| Writers Room draft bodies: new work, draft save and version snapshot (`writersRoom/local.js`) | Covered (#9982): each holds one lease from the `.md` write through the manifest row that names it; a draft save replaces its body in place |
| Writers Room tombstone prune (`writersRoom/sync.js`) and polish snapshots (`writersRoom/polish.js`) | Reference-only: the prune drops the rows before it removes their directories, and polish snapshots are JSON files no row names (revert writes the draft through the admitted save) |
| Image-to-3D mesh completion and AR export (`imageTo3d/models.js`) | Covered (#9982): the runner writes `model.glb` outside admission and only the row that marks it ready takes the lease; the AR export's file write and the row stamping it are one lease |
| Image-to-3D record deletion (`imageTo3d/models.js`) | Reference-only: the row is soft-deleted before the render directory is removed |
| Rigging and animation retarget (`rigging/autoSkin.js`, `rigging/retarget.js`) | Covered (#9982): the pair is published into its own directory and verified outside admission; the row that first names it takes the lease |
| Catalog ingredient media and voice-memo scraps, imported round reference audio, Persistent Mind screenshots and songbook attachments (`catalogMedia.js`, `catalogIngestSources.js`, `roundReferenceAudioImport.js`, `persistentMindAttachments.js`, `routes/brainSongbook.js`) | Covered (#9982): the row that first names a landed file takes the lease; the file-backed Persistent Mind and songbook records hold it through their deletions too |
| Mood board re-hosting, Pinterest and X imports, frame extraction and collages (`moodBoard/*.js`) | Covered (#9982): downloads and renders run outside admission; the board row that first names them, and each in-place rewrite of a URL-keyed download, take the lease |
| Code Animation generated HTML, package import and repair revisions, production stage-run artifacts, Blender film publication and the soundtrack mux install (`codeAnimation/index.js`, `projects.js`, `stages.js`, `blenderRender.js`, `sound.js`) | Covered (#9982): write-once revision trees and run artifacts land first, and the revision, run or history row that first names them commits under the lease; the mux's in-place install over an already-named render takes it too |
| Code Animation export staging and output acceptance (`codeAnimation/export.js`, `codeAnimation/acceptance.js`) | Reference-only: staging directories and worker workspaces are scratch no row names, and acceptance names a render that was already durable |
| Peer asset, draft-body and bible pulls, share bucket asset import and the peer library sweep (`sharing/peerSyncAssets.js`, `importer.js`, `peerMediaLibrarySync.js`) | Covered (#9982): downloads run outside admission; the write that lands the bytes with its sidecar, poster and `media_assets` row, the draft or bible replacement, the bucket's asset copy and the sweep's index rebuild each take the lease |
| Peer CoS archive imports (`sharing/peerCosSync.js`) | Covered (#9982): verified downloads stage outside admission; final files, index reconciliation and present-but-unindexed recovery take one lease |
| ChatGPT archive import and import-memory deletion (`chatgptImport.js`, `brain.js`; the ZIP's asset extraction in `chatgptZipImport.js`) | Covered (#9982): assets are extracted outside admission and named only by the memory row; each conversation's archived transcript and that row commit under one lease, and deleting an import memory drops the record and unlinks its transcript and unreferenced assets under one lease |
| YouTube ingest (`youtubeIngest.js`) | Covered (#9982): downloads run outside admission; the index record that first names a transcript or audio file takes the lease, and forgetting an ingest drops the record and unlinks its files under one lease |
| Digital twin documents, enrichment answers/lists, peer document sync and genome upload/delete (`digital-twin-documents.js`, `digital-twin-enrichment.js`, `digital-twin-sync.js`, `genome.js`) | Covered (#9982): each document file or raw genome file and the meta record naming it is one lease, including deletion; enrichment provider work stays outside, while peer sync holds the lease from document copying through metadata save and tombstone reaping |
| Derived media index (`mediaAssetIndex/`) | Rebuilt: `media_assets` rows are excluded from snapshot dumps; database restore rebuilds atomically from disk before reopening admission, and relevant file restores refresh the mirror |
| Explicit file purge (`dataManager.js`, `routes/uploads.js`, `routes/attachments.js`) | Covered: single and bulk deletions hold one lease. These operator-directed removals may intentionally leave external references; admission prevents a snapshot from interleaving with the removal, not from preserving that already-deleted state |
| Image generation completion, upscale/clean tails, variants and sketch pairs (`imageGen/*.js`, `mediaSketches.js`) | Covered (#9982): provider output publication through sidecar and cleanup takes one lease; remote replacement and variant/sketch rewrites restore previous files on failure |
| Pipeline audio mux (music, voice, generated cues, silent strip), including Creative Director stitch/final assembly | Covered (#9982): encoding runs outside admission; replacement of the already-recorded video and rollback hold the lease. CD final/rough-cut rows only reference the existing history entry |
| Music Video Making-of export (`makingOf.js`, `makingOfVisuals.js`) | Reference-only: reads existing assets and transforms buffers for the ZIP response; no durable file or row writes |
| Time Capsule snapshots (`timeCapsule.js`) | Covered (#9982): snapshot creation and deletion lease the file and index entry together, acquiring before the shared index write tail |
| CoS raw recording compression and purge (`cosAgentStorage.js`) | Covered (#9982): verified gzip publication, storage manifest and plain-file removal share a lease; purge intent and unlinks also share a lease because the manifest is file-primary |
| CoS agent archive/index publication (`cosAgentLifecycle.js`, `cosAgentArchive.js`, `cosAgentIndex.js`) | Covered (#9982): completion, zombie/stale archival, deletion and legacy layout migration lease directory changes through state and index publication; state-locked workflows acquire admission first |
| Game compiled manifests (`games/compile.js`) | Covered (#9982): versioned manifest and game compiled/history pointers hold one lease before the per-game queue |
| Toolkit run creation, CLI/API terminal recording and deletion (`aiToolkit/runner.js`, `internal/runFinalizer.js`) | Covered through the host-injected `withAssetPublication` boundary. Standalone toolkit defaults to direct execution. Terminal hooks run after release; output failures retain truthful persisted byte counts. The injected boundary coordinates the server and separate runner processes |
| Beeper attachment mirror (`beeperAttachments.js`) | Covered (#9982): network transfer stays outside admission; content-addressed installation/dedupe and its `local_path` row commit share admission and a path queue with eviction/orphan cleanup. This also protects snapshots that opt into the normally excluded attachment bytes |
| Runtime recording completion tails (`runtimeFilePublication.js`, server runner/TUI finalizers, CoS runner completion, loop iterations, TUI spooler) | Covered (#9982): output and completion metadata are admitted together with rollback on write failure; CoS completion retains admission through runner ownership removal. Each parsed/raw spool flush and CLI transcript/state batch is a short lease, including durable truncation/failure flags. Spawn prompt files/run creation/registration publish after forge preparation; old run pruning and feature-agent row/directory deletion are admitted. Model execution stays outside. Uses the shared process admission protocol in both server and CoS runner |
| Agent usage run creation and completion (`agentRunTracking.js`) | Covered: prompt/output creation precedes metadata inside one lease; completion holds output replacement through terminal metadata, with usage and event callbacks after release |
| Snapshot consistency claim (`backupAssetOwners.js`, see below) | Covered (#9982) |
| Database restore execution and backend-cutover acceptance (`backup.js`, `databasePreflight.js`) | Covered (#9983) |

Direct gallery uploads encode before admission, then publish the final image,
sidecar, and derived index row under one lease. Prompt/visibility edits and
image/video deletions take admission before their first read or removal and
hold it through the index update. A snapshot requested halfway through one of
these workflows drains it; a mutation arriving during a snapshot waits until the
file copy, SQL dump, and manifest are done. These leases do not make the two
stores transactional: existing best-effort index failures can still leave
stale derived rows for reconciliation, and a delete can leave other records
that referenced the asset. The admission timeout/failure path still refuses the
snapshot and preserves older recovery points.

LoRA datasets keep their metadata beside their images rather than in PostgreSQL.
Their admitted workflows prevent rsync from capturing a half-applied image/record
mutation too: upload/import normalization, reference-sheet cropping, generated
image copies and recovery replacements, and image/dataset removal each hold one
lease through their final metadata or file operation. Record edits acquire
admission before joining the dataset write queue. Completion listeners acquire
their own lease synchronously during queue fan-out; rendering, queue waits,
captioning, and the vision crop proposal stay outside admission. Local image
normalization/cropping and copying are included in the lease. Pending `rendering`
entries can still name files that do not exist yet, and admission does not repair
pre-existing missing files or make failed writes transactional.

Voice Studio holds admission after inference has produced its WAV and before
creating or copying final source assets, until the corresponding profile row
commits or failed-write cleanup finishes. Music Video development artifacts
validate their media policy outside admission, then hold one lease from the
versioned file write through project-record mutation and cleanup. Vocal stems
probe the master and upload outside admission, then hold one lease from library
copy through the project update. A failed row write can still leave an
unreferenced library stem; it cannot make a completed snapshot point at absent
bytes.

Universe Builder render listeners take their lease synchronously inside the
completion fan-out, so a cut that is already draining waits for a character
sheet's copy and pointer stamp, or a render's collection filing, entry-ref
append and sidecar enrichment. The gallery delete route holds one lease from
removing the image through dropping every universe canon `imageRefs` entry that
named it, and reference-sheet deletion holds one from the pointer read through
the pointer purge. Sidecar enrichment shares the gallery's per-image edit queue,
so it cannot drop a concurrent prompt or visibility edit. Records outside
universe canon that named a deleted image (media-collection items, for example)
keep their references; only universe canon references are purged with it.

Creative Director frame sampling holds its lease while ffmpeg decodes the
clip, a few seconds for a typical scene; the evaluator dispatch that follows
stays outside it.

Sprite animation completion files the finished clip under one lease: staging the
MP4, decoding and packaging its frames, and the run record that names them. It
takes the lease before the per-record write tail, so a filing queued behind a
long Reprocess holds its lease while it waits and can stretch a cut's drain by
that wait. Voice benchmarks synthesize outside admission, then write every WAV
and the benchmark row under one lease. A fine-tune job's checkpoints are written
by the training process, which cannot be admitted, so the job record that first
names each sealed checkpoint takes the lease instead. The music library's upload
copy and its deletion each hold a lease; deletion leaves the issues and projects
that named the track pointing at the removed file, as before. The pipeline audio
routes (music generation, cue render, voice-over line render) hold the lease only
around the row commit: the sidecar or synthesizer has already written the WAV,
possibly while a cut was running, and a row that waits out the cut can only name
audio the snapshot copied, or nothing. Music library uploads need no lease of
their own at the row: the admitted import copies the file first.

LoRA training registers its adapter, sidecar, run row and dataset flag under one
lease, and checkpoint promotion does the same while it overwrites the deployed
adapter in place; the completion event fires after the lease so the media
queue's own admitted commit never borrows it. The trainer writes samples and
checkpoints itself, so only the progress row that first names them takes the
lease, and a progress-only update never waits out a cut. Run deletion holds one
lease from the artifact-directory removal through the LoRA unlink, the dataset
reset and the row delete. A LoRA deleted from the manager leaves runs and other
records that named it pointing at the removed file, so that unlink holds the
lease too. A downloaded LoRA is linked under its final name before its sidecar
is written; the sidecar write takes the lease, so a snapshot can hold weights
without their sidecar (they list with fallback metadata) but never a sidecar
without its weights.

A Music Video render holds no lease while it encodes. Once the MP4 is on disk,
the final render's poster, its video-history entry and the project row naming
that entry commit under one lease; an excerpt's settling row (naming its MP4
and contact sheet) does the same. A publishing-kit build commits the kit row
naming its encodes, thumbnails and captions under a lease, then removes the
previous kit's files no project still names. A composition document version is
renamed into place before the row that selects it commits under a lease, and
pruning removes only version folders no row names. The in-flight
`renderPartialFilename` / excerpt `partialFilename` marks still name a file the
encoder is writing, as before; boot recovery clears them.

Writers Room draft saves hold one lease from the in-place `.md` replacement
through the manifest row, so a cut never copies old prose beside a row that
describes the new text; creating a work and snapshotting a version do the same
for the new body file. A mesh the image-to-3D runner writes in place stays
unreferenced until the row that marks it ready commits, and that commit takes the
lease; a cut taken mid-render dumps the `generating` row, which restore recovers
as failed. Rig and retarget pairs are never replaced: the verified pair sits in
its own directory and only the row naming it takes the lease. Deleted works and
models keep their directories until tombstone GC or the render settles, after
their rows stopped naming them.

Catalog uploads and voice memos, a voice-memo scrap and an imported round
reference audio land their file first; the row that first names it commits
under the lease, so transcription, extraction and the yt-dlp download stay
outside. Persistent Mind screenshot records and songbook attachment lists live
in `data/` files, which one rsync pass copies at a different moment than the
bytes, so their deletions hold the lease from the unlink through the record
write, and a songbook upload holds it from the byte write. The Persistent
Mind's expired-upload sweep, which runs before each message and upload, skips
its pass while a cut is pending instead of delaying them. Mood board downloads,
frame extraction and collage rendering run outside admission; the board row that
first names the result commits under the lease. Re-hosted, Pinterest and X
downloads are keyed by their source URL and rewrite the file in place on a
repeat, so that write takes the lease too. Removing a board item or a board
removes no bytes. A row that fails after its file landed leaves an unreferenced
file, as before.

Gallery video uploads hold admission from the first byte installation through
their thumbnail and history entry; failed history writes remove both outputs
before releasing admission. The yt-dlp producer downloads fresh, unreferenced
files outside admission, then the poster and history commit take one lease,
including rollback. Failed or canceled producers remove their unreferenced
fragments through the existing download core. Poster edits take admission before
the shared history write tail and retain it through poster creation, history
replacement, old-poster cleanup and failed-commit cleanup. Every new poster uses
a fresh basename; temporary sharing copies stay outside this durable workflow.
Upload and download completion notifications run after the durable commit, so
a throwing listener cannot remove files that committed history already names.
These leases do not repair preexisting dangling references. The derived media
index can lag live edits; it is excluded from dumps and rebuilt from authoritative
sidecars and history during restore as described below.

Local generated videos (including each batch member) and Grok, fal and Reactor
videos share an admitted finalizer. Fresh producer output is unreferenced until
that finalizer takes admission before faststart and poster creation, then commits
serialized history or removes the owned video, possible partial poster and
faststart staging file before releasing the lease. A missing thumbnail retains
the existing thumbnail-less behavior. Terminal status and notifications follow
the durable commit. Caller publication latches keep committed outputs and earlier
batch members out of later failure or cancellation cleanup. Federated video
transfers verify a staging file outside admission, then lease replacement,
poster generation and history together. A failed replacement restores the prior
clip and poster before releasing admission; replay replaces the existing row.
Derived stitch, inline and queued upscale, timeline and HTML-composition renders
produce fresh output outside admission, then lease poster and history publication
through rollback. HTML compositions commit all formats together. 

The derived media index is excluded from snapshot dumps: its asynchronous refresh may lag authoritative files, so preserving its rows would preserve stale file references. Both legacy and new database restores rebuild it atomically from local sidecars and video history before reopening admission. Unreadable sources or SQL failure keep recovery fenced for a same-operation retry, without replaying the dump. Full and media-selective file restores rebuild it too; a failed rebuild is reported as a reconciliation failure. This does not make unadmitted authoritative media workflows consistent.

Code Animation writes its HTML, revision trees and run artifacts before the row
that first names them. A generated animation's HTML and the job row marking it
completed hold one lease. A package import or repair stages its revision into a
fresh write-once directory outside admission, then commits the revision row
under the lease; the import's `staging` run row names that directory before
its bytes land, but it is never a revision and a restart marks it interrupted.
Every production run-row write takes the lease, because the row is what first
names the stage's frames, soundtrack WAV and Blender bake. A Blender film is
copied under a fresh name and muxed before its history entry commits under the
lease. A browser render's history entry is written by the HTML-composition job
under admission, so the soundtrack mux holds the lease
across its in-place install over that file, but not across the encode.

A sprite's row holds metadata and workflow state (status, the frozen chroma key,
the publish binding), never a path, and its bytes live under `data/sprites/<id>/`.
The workflows whose row mirrors a file state therefore hold one lease: reference
lock and unlock (manifest and row), walk set finalization (the set, then the
row that says `walk-complete`), and unlock, reopen and revision (remove the set,
then downgrade the row). A copy that predates the set paired with a row dumped
after it would advertise a finished walk with nothing behind it, which the write
order was chosen to prevent against a crash but cannot against a copy-then-dump
snapshot. A source-pipeline import holds a lease per subject, a character or a
props family, from its first copied byte through the row marking it imported, so a
multi-subject import lets a cut in between subjects. The grok-TUI lanes run the
terminal session outside admission and take the lease for the attach that packages
its frames and files the run, as the local completion hook does. The leases are
taken before the per-record write tail, so a workflow queued behind a long
reprocess holds its lease while it waits and can stretch a cut's drain by that
wait. Generation starts, uploads, run records, selections, loop trims, atlas
compiles, asset deletion and publication also take admission before the shared
animation/reference write tails. Their file-primary manifests and runtime
pointers need the same protection even when the PostgreSQL sprite row contains
no path: writing a record last alone cannot protect a multi-file rsync pass.

**Snapshot consistency claim.** `server/lib/backupAssetOwners.js` inventories
each durable owner as `admitted`, `reference-only` or `outstanding`, and its
test fails when an `admitted` entry stops taking the lease or a module that
takes the lease is missing from the inventory. Every snapshot records the claim
derived from it as `assetConsistency` in its `manifest.json`, the backup status
(`GET /api/backup/status`) and the run result. `scope: "global"` is reported
only when no owner is outstanding; until then the scope is `admitted-owners`
and `outstanding` lists the owner ids still outside admission. An unrecognized
status counts as outstanding, never as covered. Snapshots written before this
field existed carry no claim and must be treated as partial.

The completed inventory covers the identified managed runtime workflows in this
repository. New byte-plus-record workflows must be classified before they can
participate in the guarantee; an `outstanding` or unknown status downgrades the
snapshot claim. The global scope requires both server and CoS runner to use the
shared protocol. It excludes arbitrary external scripts/tools and does not repair
preexisting missing assets, deliberate operator deletion, or corruption left by a
failed migration. Managed startup migrations finish before backup routes and the
scheduler become available; this ordering prevents concurrent capture, not a
claim that every migration necessarily succeeded.

No authoritative asset domain is excluded merely to satisfy readiness. Existing
explicit backup exclusions still apply; the derived media index is reconstructed
from authoritative files instead of preserving cache rows.

When wrapping one of them, remember the order a cut works in: it copies files,
then dumps rows. A row that names new bytes therefore has to commit under the
lease unless the lease already covered the byte write. A deletion that removes
a PostgreSQL row first and the bytes second is safe either way, because the dump
that follows the copy sees no row. A file-primary record and its bytes require
admission even for record-first deletion: rsync copies them independently. A deletion that unlinks first, or one that leaves
rows naming the removed file, must hold the lease around the unlink.

This is part of [the cross-store consistency work](https://github.com/atomantic/PortOS/issues/9923).
While `assetConsistency.scope` is `admitted-owners`, `status: ok` reports that
the file copy, manifest, and database dump completed; it does not assert that
every database asset reference resolves to the captured filesystem bytes. A
restore operator should verify the outstanding owners' assets before treating
a snapshot as a complete recovery point.

Now that PostgreSQL is a **required** dependency (it owns the creative catalog, memory, and a growing set of app-native records — see [Storage Classification Contract](./STORAGE.md)), **the database dump is part of required system state, not an optional extra.** A snapshot that captured `data/` but failed to capture the DB is incomplete, and PortOS surfaces that explicitly.

The dump includes the machine-local `cos_pending_agent_feedback` reference index, the `cos_tasks` CoS task queues and their completed-task history (the Markdown task files were retired into it and kept as `*.imported`), the `cos_agents` CoS agent working set (moved out of `data/cos/state.json`, whose pre-migration copy is kept as `state.json.imported`), and `review_queue_triage` presentation markers. The queue's source records remain in their owning stores; restoring the dump therefore preserves snooze/dismissal decisions without exporting them through federation or duplicating source payloads.

Implementation: `server/services/backup.js` (snapshot/dump/restore), `server/services/backupScheduler.js` (cron), `server/routes/backup.js` (API), and `server/routes/database.js` (DB export/sync).

Snapshot dump and replay use the endpoint and credentials captured by the active
pool at server startup. Changing `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, or
`PGPASSWORD` requires restarting PortOS. Inherited libpq overrides (including
`PGHOSTADDR`, service files and `PGOPTIONS`) are removed from these subprocesses.
TLS is captured at startup too: disabled TLS stays disabled, verified TLS uses
`verify-full` with a temporary PEM file containing Node’s active trust roots, and `no-verify` uses `require`. Inline TLS
certificate settings are refused rather than silently weakened. Executable
resolution (`PATH` and `PORTOS_PGDUMP`) is preserved.
