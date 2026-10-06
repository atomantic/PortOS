# Backup & Restore

PortOS backs up two things together, into a single timestamped snapshot:

1. **Filesystem data** — an rsync mirror of `./data/` (with SHA-256 manifest).
2. **PostgreSQL** — a `pg_dump` logical dump (`portos-db.sql`) written alongside the snapshot.

### Consistency while assets are changing

The backup service closes a process-local publication boundary before copying
`data/`, drains music-track take publications already in progress, and keeps
new take publications waiting through the SQL dump and manifest write. Browser
code takes, SuperCollider takes, chiptune renders, and painted-waveform renders
stage encoding outside that boundary, then publish their final audio bytes and
track row together inside it. Manual and scheduled backups use the same cut.
If an admitted take does not drain within two minutes, or the cut cannot be
released, the snapshot is marked failed (never published or used for retention
pruning) and take publication reopens.

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
  incomplete guards exactly as they were. The boundary is process-local; the
  detached cutover worker runs only after the server stops.

Admission inventory (`withBackupAssetPublication`):

| Owner | Status |
| --- | --- |
| Music Designer take publication (`musicTakePublication.js`) | Covered (#9980) |
| Media-job completion: queue terminal row + `completed` fan-out (`mediaJobQueue/index.js`) | Covered |
| Attach hooks on `completed` via `mediaJobImageHook.js` (writers-room, catalog, music-video scene image/video/cast-sets, CD scene image/music bed, FableLoom scene image/video, sprite references, deck cards, music studio) | Covered |
| Pipeline filename hooks (`filenameHookFactory.js` comic pages and storyboards, `seasonCoverFilenameHook.js`) | Covered |
| Recovery commit of a completion whose terminal write failed (`mediaJobQueue/index.js`) | Covered: only an admitted snapshot commits it (#9982 partial) |
| Universe Builder completion listeners: collection filing, canon entry-ref append, and sidecar enrichment (`universeBuilderCollectionHook.js`); character reference sheet copy and pointer stamp (`universeCharacterSheet.js`) | Covered (#9982 partial) |
| Creative Director evaluation frames: render-completion sampling (`creativeDirector/sceneRunner.js`) and the resume pass that re-samples missing frames in place (`creativeDirector/completionHook.js`) | Covered from the first `${jobId}-fN.jpg` write through the scene row that names them (#9982 partial) |
| Creative Director render settlement (scene status and auto-accept, plan-step settle, seed-frame wait) and Music Video production step settlement (`musicVideo/productionService.js`) | Reference-only: these write no bytes, and the render they name was on disk before its admitted completion published |
| Sprite animation completion: clip copy, frame packaging and run record (`sprites/localAnimationJobHook.js`) | Covered from clip staging through the run record that names the packaged frames (#9982 partial) |
| Sprite reference lock and unlock, walk set finalization, unlock, reopen and anchor/turnaround revision, source-pipeline import, and the grok-TUI attach lanes for walk and named tracks (`sprites/reference.js`, `sprites/walk.js`, `sprites/importer.js`, `sprites/animationTrackWorkflow.js`) | Covered (#9982 partial): each holds one lease from its first byte through the sprite row it pairs with (or, for the attach lanes, the run record naming the packaged frames) |
| Sprite generation starts, reference uploads, candidate and run records, selections, loop trims, atlas compile, publication history, asset deletion and the publish-binding row (`sprites/walkTrims.js`, `atlas.js`, `assets.js`, `publish.js`, and the non-lock paths of `reference.js`, `walk.js`, `animationTrackWorkflow.js`) | Reference-only: the sprite row holds no path under `data/`, the versioned artifacts are write-once, and the record naming them is written last |
| Direct gallery upload, image prompt/visibility sidecar replacement, and image deletion (`imageGen/local.js`) | Covered as one file/sidecar/index workflow (#9982 partial) |
| Gallery image deletion's universe canon purge (`galleryImageDeletion.js`) and character reference sheet deletion (`universeCharacterSheet.js`) | Covered from file removal through the universe pointer purge (#9982 partial) |
| Video-history deletion, including downloaded-video deletion (`videoGen/historyOps.js`) | Covered through file/history/index removal (#9982 partial) |
| Gallery video upload, download finalization and poster edits (`videoUpload.js`, `videoDownload.js`, `videoGen/poster.js`) | Covered (#9982 partial): uploads lease byte installation through history and rollback; downloads lease poster creation through history and rollback after yt-dlp finishes; poster edits lease creation, history and cleanup |
| LoRA dataset uploads, gallery imports, reference-sheet crops, generated completion/recovery copies, image/dataset deletion, and queued record edits (`loraDatasets.js`, `loraDatasetGenerate.js`) | Covered as complete file/record workflows (#9982 partial) |
| Voice Studio audition and character assignment (`voice/studio.js`) | Covered from source-file write/copy through profile-row commit and failed-write cleanup (#9982 partial) |
| Music Video development artifact import/generated save and vocal-stem attachment (`musicVideo/devArtifactService.js`, `musicVideo/vocalStem.js`) | Covered from final file copy/write through project-record commit and failed-write cleanup (#9982 partial) |
| Music-library upload copy and deletion (`pipeline/musicLibrary.js`) | Covered (#9982 partial): the copy and the unlink each hold one lease; the delete route intentionally leaves existing issue/project references to the removed file |
| Voice benchmark audio and row (`voice/profileBenchmarks.js`), cloned-candidate recording and row (`voice/profiles.js`), and the fine-tune job record that names each sealed checkpoint (`voice/fineTuning.js`) | Covered (#9982 partial); promoting a checkpoint writes only a row naming bytes the job record already named |
| Pipeline audio stage rows: generated music, cue render and voice-over line render (`routes/pipeline/audio.js`) | Covered (#9982 partial): the row that first names the WAV takes the lease; the sidecar or synthesizer writes the WAV before it |
| Music-library upload attach: Music Designer upload, pipeline music upload and YouTube import (`routes/tracks.js`, `routes/pipeline/audio.js`, `trackYoutubeImport.js`) | Reference-only: the admitted library import copies the file first and the track or issue row commits after it |
| LoRA training and deployed LoRAs: trained-adapter registration, checkpoint promotion over the deployed adapter, the promoted-checkpoint preview copy, the progress row naming trainer-written samples and checkpoints, run deletion, and LoRA deletion from the LoRA manager or Media Models (`loraTraining/index.js`, `loras.js`) | Covered (#9982 partial): registration and promotion hold one lease from the adapter write through the run row and dataset flag; Civitai and Hugging Face installs admit the sidecar that first names the already-linked weights |
| Music Video final and excerpt renders, publishing-kit builds and composition document versions (`musicVideo/render.js`, `musicVideo/excerptRender.js`, `musicVideo/publishKit.js`, `musicVideo/compositionDocument.js`) | Covered (#9982 partial): the encoder or import writes the files in place; the history entry and project row that first name them commit under one lease |
| Music Video excerpt deletion (`musicVideo/excerptService.js`) | Reference-only: the project row drops the excerpt before its unreferenced video and contact sheet are unlinked |
| Music Video performance repair, MIDI transcription and the autonomous Suno song (`musicVideo/performanceRepair.js`, `audioMidiTranscription.js`, `musicVideo/autonomousService.js`) | Covered (#9982 partial): the boundary frame or `.mid` is written first; the row that first names it (repair revision, project MIDI pointer, track render) commits under one lease, and a declined MIDI result is unlinked inside it |
| Writers Room draft bodies: new work, draft save and version snapshot (`writersRoom/local.js`) | Covered (#9982 partial): each holds one lease from the `.md` write through the manifest row that names it; a draft save replaces its body in place |
| Writers Room tombstone prune (`writersRoom/sync.js`) and polish snapshots (`writersRoom/polish.js`) | Reference-only: the prune drops the rows before it removes their directories, and polish snapshots are JSON files no row names (revert writes the draft through the admitted save) |
| Image-to-3D mesh completion and AR export (`imageTo3d/models.js`) | Covered (#9982 partial): the runner writes `model.glb` outside admission and only the row that marks it ready takes the lease; the AR export's file write and the row stamping it are one lease |
| Image-to-3D record deletion (`imageTo3d/models.js`) | Reference-only: the row is soft-deleted before the render directory is removed |
| Rigging and animation retarget (`rigging/autoSkin.js`, `rigging/retarget.js`) | Covered (#9982 partial): the pair is published into its own directory and verified outside admission; the row that first names it takes the lease |
| Catalog ingredient media and voice-memo scraps, imported round reference audio, Persistent Mind screenshots and songbook attachments (`catalogMedia.js`, `catalogIngestSources.js`, `roundReferenceAudioImport.js`, `persistentMindAttachments.js`, `routes/brainSongbook.js`) | Covered (#9982 partial): the row that first names a landed file takes the lease; the file-backed Persistent Mind and songbook records hold it through their deletions too |
| Mood board re-hosting, Pinterest and X imports, frame extraction and collages (`moodBoard/*.js`) | Covered (#9982 partial): downloads and renders run outside admission; the board row that first names them, and each in-place rewrite of a URL-keyed download, take the lease |
| Code Animation generated HTML, package import and repair revisions, production stage-run artifacts, Blender film publication and the soundtrack mux install (`codeAnimation/index.js`, `projects.js`, `stages.js`, `blenderRender.js`, `sound.js`) | Covered (#9982 partial): write-once revision trees and run artifacts land first, and the revision, run or history row that first names them commits under the lease; the mux's in-place install over an already-named render takes it too |
| Code Animation export staging and output acceptance (`codeAnimation/export.js`, `codeAnimation/acceptance.js`) | Reference-only: staging directories and worker workspaces are scratch no row names, and acceptance names a render that was already durable |
| Peer asset, draft-body and bible pulls, share bucket asset import and the peer library sweep (`sharing/peerSyncAssets.js`, `importer.js`, `peerMediaLibrarySync.js`) | Covered (#9982 partial): downloads run outside admission; the write that lands the bytes with its sidecar, poster and `media_assets` row, the draft or bible replacement, the bucket's asset copy and the sweep's index rebuild each take the lease |
| Peer CoS archive imports (`sharing/peerCosSync.js`) | Covered (#9982 partial): verified downloads stage outside admission; final files, index reconciliation and present-but-unindexed recovery take one lease |
| ChatGPT archive import and import-memory deletion (`chatgptImport.js`, `brain.js`; the ZIP's asset extraction in `chatgptZipImport.js`) | Covered (#9982 partial): assets are extracted outside admission and named only by the memory row; each conversation's archived transcript and that row commit under one lease, and deleting an import memory drops the record and unlinks its transcript and unreferenced assets under one lease |
| YouTube ingest (`youtubeIngest.js`) | Covered (#9982 partial): downloads run outside admission; the index record that first names a transcript or audio file takes the lease, and forgetting an ingest drops the record and unlinks its files under one lease |
| Digital twin documents, enrichment answers/lists, peer document sync and genome upload/delete (`digital-twin-documents.js`, `digital-twin-enrichment.js`, `digital-twin-sync.js`, `genome.js`) | Covered (#9982 partial): each document file or raw genome file and the meta record naming it is one lease, including deletion; enrichment provider work stays outside, while peer sync holds the lease from document copying through metadata save and tombstone reaping |
| Derived media index (`mediaAssetIndex/`) | Rebuilt: `media_assets` rows are excluded from snapshot dumps; database restore rebuilds atomically from disk before reopening admission, and relevant file restores refresh the mirror |
| Explicit file purge (`dataManager.js`, `routes/uploads.js`, `routes/attachments.js`) | Covered: single and bulk deletions hold one lease. These operator-directed removals may intentionally leave external references; admission prevents a snapshot from interleaving with the removal, not from preserving that already-deleted state |
| Image generation completion, upscale/clean tails, variants and sketch pairs (`imageGen/*.js`, `mediaSketches.js`) | Covered (#9982 partial): provider output publication through sidecar and cleanup takes one lease; remote replacement and variant/sketch rewrites restore previous files on failure |
| Pipeline audio mux (music, voice, generated cues, silent strip), including Creative Director stitch/final assembly | Covered (#9982 partial): encoding runs outside admission; replacement of the already-recorded video and rollback hold the lease. CD final/rough-cut rows only reference the existing history entry |
| Music Video Making-of export (`makingOf.js`, `makingOfVisuals.js`) | Reference-only: reads existing assets and transforms buffers for the ZIP response; no durable file or row writes |
| Time Capsule snapshots (`timeCapsule.js`) | Covered (#9982 partial): snapshot creation and deletion lease the file and index entry together, acquiring before the shared index write tail |
| CoS raw recording compression and purge (`cosAgentStorage.js`) | Covered (#9982 partial): verified gzip publication, storage manifest and plain-file removal share a lease; purge intent and unlinks also share a lease because the manifest is file-primary |
| CoS agent archive/index publication (`cosAgentLifecycle.js`, `cosAgentArchive.js`, `cosAgentIndex.js`) | Covered (#9982 partial): completion, zombie/stale archival, deletion and legacy layout migration lease directory changes through state and index publication; state-locked workflows acquire admission first |
| Game compiled manifests (`games/compile.js`) | Covered (#9982 partial): versioned manifest and game compiled/history pointers hold one lease before the per-game queue |
| Durable replacement/deletion owners not yet classified | Outstanding (#9982) |
| Snapshot consistency claim (`backupAssetOwners.js`, see below) | Covered (#9982 partial) |
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
These leases do not repair dangling references or stale derived index metadata.
The completion-hook and reconcile writes to `media_assets`, and poster edits
leaving its old thumbnail pointer, are explicitly outstanding as
`media-asset-index-refresh`; the final sweep must settle their restore semantics.

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
compiles, asset deletion and the publish binding take no lease: their row names no
bytes, versioned outputs are written once, and the record that names them lands
last. A cut can still copy part of a multi-file sprite tree written by one of those
workflows, as it can for any file-backed record in `data/`.

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

The remaining inventory is the `outstanding` entries in `backupAssetOwners.js`,
grouped by domain with the modules whose file-plus-record workflows still run
outside admission, plus an `unclassified-durable-owners` entry for anything a
code sweep did not reach. Their persistence adapters and direct filesystem calls
still need workflow-level classification; independently locking `fileCore` or
SQL primitives would not cover the gap between writes. No authoritative asset domain is excluded
from the snapshot to satisfy the claim; the derived media index is reconstructed
from the authoritative files instead of preserving cache rows.

When wrapping one of them, remember the order a cut works in: it copies files,
then dumps rows. A row that names new bytes therefore has to commit under the
lease unless the lease already covered the byte write. A deletion that removes
the row first and the bytes second is safe either way, because the dump that
follows the copy sees no row. A deletion that unlinks first, or one that leaves
rows naming the removed file, must hold the lease around the unlink.

This is part of [the cross-store consistency work](https://github.com/atomantic/PortOS/issues/9923).
While `assetConsistency.scope` is `admitted-owners`, `status: ok` reports that
the file copy, manifest, and database dump completed; it does not assert that
every database asset reference resolves to the captured filesystem bytes. A
restore operator should verify the outstanding owners' assets before treating
a snapshot as a complete recovery point.

Now that PostgreSQL is a **required** dependency (it owns the creative catalog, memory, and a growing set of app-native records — see [Storage Classification Contract](./STORAGE.md)), **the database dump is part of required system state, not an optional extra.** A snapshot that captured `data/` but failed to capture the DB is incomplete, and PortOS surfaces that explicitly.

The dump includes the machine-local `cos_pending_agent_feedback` reference index and `review_queue_triage` presentation markers. The queue's source records remain in their owning stores; restoring the dump therefore preserves snooze/dismissal decisions without exporting them through federation or duplicating source payloads.

Implementation: `server/services/backup.js` (snapshot/dump/restore), `server/services/backupScheduler.js` (cron), `server/routes/backup.js` (API), and `server/routes/database.js` (DB export/sync).

Snapshot dump and replay use the endpoint and credentials captured by the active
pool at server startup. Changing `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, or
`PGPASSWORD` requires restarting PortOS. Inherited libpq overrides (including
`PGHOSTADDR`, service files and `PGOPTIONS`) are removed from these subprocesses.
TLS is captured at startup too: disabled TLS stays disabled, verified TLS uses
`verify-full` with a temporary PEM file containing Node’s active trust roots, and `no-verify` uses `require`. Inline TLS
certificate settings are refused rather than silently weakened. Executable
resolution (`PATH` and `PORTOS_PGDUMP`) is preserved.

## Database backend migration

Settings (Database tab) offers a coordinated offline cutover between Docker and
native PostgreSQL. It stops/drains every PortOS writer (including the CoS
runner), transfers the data, commits the new backend, restarts, and verifies
the restarted server's target connection before reporting success — the same
lifecycle `POST /api/database/maintenance/cutover` runs for automation (the
Settings tab submits that same request; it uses the ordinary instance
authentication gate). `scripts/database-maintenance.mjs` is **not** a complete
migration path: its `begin` command only admits a fence and starts nothing (see
[Database maintenance admission](#database-maintenance-admission) below).
`scripts/db.sh migrate`, `use-native`, and `use-docker` still refuse directly;
native setup provisions without selecting a backend. Do not substitute Sync
followed by Switch — that copies data without stopping writers or verifying
the restart, and can strand writes accepted after the snapshot.

Expect brief downtime while PortOS restarts. The Database tab shows the
operation's stage (preparing, exporting/importing, restarting and verifying),
never reports success from an accepted request, a reconnect, or a saved-mode
change alone, and reconciles the outcome from the durable maintenance journal
on socket reconnect and page reload — because the server it is watching is the
one restarting. If the cutover worker exits before finishing, the tab shows an
interrupted state with a Resume control that continues the same recorded
operation; there is no rollback, force, or skip.

If a previous migration left records missing, preserve both backend databases
and the migration dump. The source may hold accepted writes absent from the
target; overwriting or deleting it can destroy that recovery copy. Compare and
recover the missing records before choosing an authoritative backend.
See [storage mode guidance](STORAGE.md#moving-between-docker-and-native).

### Explicit database endpoints for standalone transfers

Standalone exports and imports can bind all connection fields explicitly:

```bash
scripts/db.sh export --endpoint localhost 5432 example_user example_db recovery-copy
scripts/db.sh import --endpoint localhost 5561 example_user example_db data/db-dumps/portos-recovery-copy.sql
```

These commands require host `pg_dump` / `psql` and never fall back to a Docker
container or select a backend from saved mode. Use a `pg_dump` version compatible
with the source PostgreSQL server. The four endpoint arguments are host, port,
user, and database name; connection strings are not accepted as database names.
Supply credentials through `PGPASSWORD`, never as command arguments.
A failed export does not replace an existing dump.
Import retains the dump and uses one transaction with `ON_ERROR_STOP`.

An explicit endpoint only selects where a standalone transfer runs. Import
replaces database objects present in the dump: keep recovery copies and stop
the target's writers before restoring. These commands do not stop PortOS,
change saved mode, verify a restarted pool, or authorize a backend cutover —
use the coordinated cutover above (Settings Database tab, or the
authenticated `POST /api/database/maintenance/cutover` for automation) for
that. `scripts/database-maintenance.mjs` is admission-only and does not run it.

## What gets backed up

A backup run (`runBackup` in `server/services/backup.js`) writes to:

```
<destPath>/snapshots/<hostname>/<snapshotId>/
├── data/             # rsync mirror of ./data/ (minus excludes)
├── portos-db.sql     # pg_dump logical dump
├── manifest.json     # SHA-256 of every data/ file AND ../portos-db.sql
└── .failed           # present only when snapshot creation failed
```

- Snapshots are namespaced by `<hostname>` so one shared destination (e.g. an iCloud folder) can host backups from several federated machines without `snapshotId` collisions.
- Snapshot lists include every machine namespace in the destination, plus snapshots written directly under `snapshots/` by PortOS versions from before hostname namespaces. Each row identifies its source, so equal timestamp IDs from different machines remain separate choices. Download, file restore, and database restore keep that source attached through preview and execution. API requests that omit `source` retain the existing behavior and select the current machine; `source: "@legacy"` selects the pre-namespace root.
- The `manifest.json` hashes the SQL dump too (keyed as `../portos-db.sql`, since the dump lives one level above the `data/` tree), so a truncated or corrupt dump is detectable rather than silently trusted.

### What is excluded by default

`DEFAULT_EXCLUDES` (in `backup.js`) skips ephemeral/cache data and large re-downloadable assets — all anchored with a leading `/` (rsync filter syntax). Two tiers:

- **Non-overridable** (`overridable: false`): browser CDP profile, agent worktrees, cached jev training embeddings — caches with no irreplaceable user data; never backed up.
- **Overridable** (`overridable: true`): intermediate LoRA training checkpoints, cloned repos, reference repos, browser downloads, jev training corpora — re-downloadable or rebuildable; the user can disable these built-in exclusion rules from the Backup settings UI via `disabledDefaultExcludes`.

Deployed LoRA weights in `data/loras/` and their metadata sidecars are included by default, whether trained locally or downloaded. Promoting an earlier checkpoint copies its selected bytes there, so a backup preserves that adapter independently of excluded torch and mflux intermediate checkpoint directories. This deliberately accepts the storage cost of deployed weights. Old `disabledDefaultExcludes` entries for `/loras/*.safetensors` remain harmless; the removed default no longer needs a toggle.

#### jev project heads — excluded bulk, retained artifact

`data/jev/` (#7689) holds three things that are deliberately NOT one tier:

| Path | Tier | Why |
|---|---|---|
| `/jev/embeddings/` | excluded, non-overridable | Frozen-encoder outputs keyed by `(pair, model revision)`. Byte-identical on re-encode, and gigabytes. |
| `/jev/corpora/` | excluded, **overridable** | Rebuildable by `node scripts/jev-corpus.js`. Overridable because the forge moves on, so someone archiving a measured adoption decision may want the exact rows the numbers came from. |
| `data/jev/heads/` | **NOT excluded** | A trained head is a few thousand floats and is **not regenerable once its corpus is stale** — the queries that produced one a month ago return different rows today. It is also the only artifact here an operator made a decision about, on the strength of three measured gold-set scores. |

Everything under `data/jev/` is machine-local (ADR [privacy records machine-local](decisions/2026-08-08-privacy-records-machine-local.md)), so a snapshot that carries a head is the only copy that survives a rebuild. Retaining it costs kilobytes; excluding it would silently discard the decision.

The effective exclude list is computed by the pure `computeEffectiveExcludes()` helper (unit-tested in `backup.test.js`). The scheduled cron handler in `backupScheduler.js` re-reads settings on every run, so `destPath`, `excludePaths`, `disabledDefaultExcludes`, and `enabled` all take effect on the next run without a restart. See [Scheduling & status](#scheduling--status) for how the cron registration itself tracks settings.

#### Why every exclude must be anchored with a leading `/`

`DEFAULT_EXCLUDES` is **rsync filter syntax** — the leading `/` means "relative to the transfer root". Without the anchor, `loras/*.safetensors` also matches any `loras/` directory nested anywhere under `data/`, silently dropping unrelated user data (e.g. `brain/.../loras/`). An unanchored pattern is a data-loss bug, not a style nit.

The same rule applies to **user-entered** Additional Exclude Paths, which is the list that is easy to get wrong: rsync matches a pattern with no leading `/` at *every* level of the tree, so typing `cache/` to skip `data/cache/` also drops `training-runs/*/cache/`, and `raw/` reaches into sprite runs. The failure is silent — the snapshot reports success, it is simply smaller, and the omission surfaces only at restore. So `computeEffectiveExcludes()` **anchors each user pattern on read** (`server/lib/backupExcludes.js`), prepending `/` to anything that is not already anchored and is not deliberately wildcard-led.

- Anchoring happens at read time, never in storage: `settings.json` keeps exactly what you typed, so there is nothing to migrate and nothing is rewritten under you. The Backup tab anchors a pattern as you add it and renders the computed effective list, so the chip you see is the filter that will run.
- **`**/name/` is the explicit way to ask for any-depth matching.** A pattern starting with `*` or `**` is passed through unchanged — that is how you deliberately say "every `cache/` anywhere", rather than getting it by accident.
- Patterns are bounded at the settings boundary (`backupConfigSchema` in `server/lib/validation.js`), and a `..` segment or a NUL byte is rejected rather than sanitized. The 256-character cap is measured on the **anchored** form — the string rsync is handed — so the boundary accepts exactly what `computeEffectiveExcludes()` keeps, and a pattern can never be saved as valid and then silently dropped at run time.

The two `overridable` tiers are enforced, not advisory. A hand-edited `settings.json` that lists a non-overridable path in `disabledDefaultExcludes` is silently dropped server-side; `computeEffectiveExcludes()` enforces both the overridable allow-list and `Array.isArray` guards for hand-edited settings. The Backup tab switches describe default rule state: switching on disables that default exclusion, and switching off re-enables it. The summary counts enabled and disabled default rules, not included files.

Additional Exclude Paths is independent: toggling a default never removes custom patterns, and custom rsync patterns remain accepted even when they overlap defaults. Additional rules still apply when a default is disabled, so deployed LoRA weights can still be omitted by explicit custom patterns: `*.safetensors` or `/lo*/` can still exclude them. `computeEffectiveExcludes()` produces the filter list; rsync alone decides which paths match. The UI does not predict snapshot contents.

## The Postgres dump is mandatory, not optional

`dumpPostgres()` runs `pg_dump --no-owner --no-acl --clean --if-exists` and returns an explicit status (no silent failure):

| Result | Meaning | Effect on backup |
|---|---|---|
| `{ status: 'ok', sizeBytes, tableCount }` | Dump succeeded and is non-empty | Backup `ok` |
| `{ status: 'failed', reason: 'pg_unreachable' \| 'pg_dump_missing' \| 'version_mismatch' \| 'dump_error' \| 'empty_dump' }` | Postgres is the active backend but the dump failed | Backup **`degraded`** + warning toast |
| `{ status: 'skipped', reason: 'not_configured' }` | The explicit file escape hatch is active — `MEMORY_BACKEND=file` or the backend resolved to `file` (dev/test, unsupported for production) | Backup stays `ok` (benign) |

Key behaviors, accurate to the code:

- **A failed dump degrades the whole backup.** `backupStatusForPg()` maps `failed → 'degraded'`; the run persists `pgBackup` into `data/backup/state.json` and emits a `BACKUP_DB_DUMP_FAILED` warning through the error pipeline — **even on unattended scheduled runs** (which pass `io = null`; the service falls back to the module-level `getIo()`).
- **A skipped dump is still benign** only for the temporary `MEMORY_BACKEND=file` escape hatch (documented as unsupported for production installs). On a normal install where Postgres is active or auto-detected, an unreachable DB returns `failed/pg_unreachable`, not a green "not configured" run.
- **`--clean --if-exists`** makes the dump replay cleanly into a live, already-initialized PortOS database — the common restore target — instead of erroring on `relation already exists`.
- A `pg_dump` that exits 0 but produces a 0-byte file is treated as `failed/empty_dump`; a non-zero exit deletes the partial file so a later restore can't trust a truncated dump.
- **`version_mismatch`** means no installed `pg_dump` is new enough for the running server (`pg_dump` aborts when older than the server it dumps — the common Homebrew case where an old `postgresql@NN` keg shadows a newer running server in `PATH`). `dumpPostgres()` reads the server's major version (`getServerMajorVersion()` in `lib/db.js`) and auto-selects the closest `pg_dump` whose major is `>=` the server from the installed Homebrew kegs / Postgres.app bundles. Set `PORTOS_PGDUMP=/path/to/pg_dump` to override the auto-discovered binary (e.g. on Linux/Windows where the keg locations don't apply).

## How restore works

Restore is two independent operations — restoring files and restoring the DB are separate decisions. Both are **dry-run by default** and validate `snapshotId` and an optional source namespace against path traversal before touching anything. Explicit source selections also reject symbolic-link aliases for the snapshots root, source namespace, or selected snapshot before archive or restore reads begin.

A backup run that fails after creating its snapshot directory records a durable `.failed` marker before releasing its `.in-progress` guards. Failed snapshots are never eligible for file or database restore (`SNAPSHOT_FAILED`); they remain downloadable so their partial files can be inspected or recovered manually. If PortOS cannot write the failed marker, it keeps the existing incomplete markers instead, which also block restore. Snapshots created by older PortOS versions without a manifest or failure marker retain their legacy behavior because an unmarked historical failure cannot be distinguished reliably from a genuine pre-manifest snapshot.

### Files — `restoreSnapshot()`

Before rsync can read or overwrite live data, PortOS strictly reads `manifest.json`, validates every manifest path and SHA-256 value, and hashes every recorded regular file in the selected restore scope. A missing, unreadable, mismatching, or unrecorded selected file refuses both preview and execution before rsync starts. Selective restore verifies only its literal selected subtree and ignores the separately handled `../portos-db.sql` entry. The same preflight runs again for execution, so changing or adding snapshot bytes after a successful preview cannot bypass verification. Readable symlinks retain the hash behavior used when the manifest was created; dangling symlinks remain outside the regular-file manifest and retain rsync's archive compatibility.

Snapshots from PortOS versions that predate `manifest.json` remain restorable as an explicit compatibility case. Restore responses report `verification.status` as `verified` (with `checkedFiles`) or `unverified` with reason `manifest_absent`; the confirmation panel warns when a legacy restore cannot be verified. An existing manifest that is malformed or unreadable fails closed and is never treated as legacy absence.

After the preflight, rsync copies `<snapshot>/data/` back to `./data/`. Restore always passes `--checksum`, so rsync compares file contents even when the live file has the same size and modification time as the snapshot; equal-content files remain skippable, while differing bytes appear in previews and are restored. This applies to dry-run and live restores, including selective subdirectory restores and legacy snapshots without a manifest. `dryRun: true` (the default) reports what would change without writing; an optional `subdirFilter` limits the restore to one subdirectory.

#### Database authority is not restored

`data/database-authority.json` is backed up as cutover evidence but is never installed by a file restore. It records which database backend a completed cutover retired on the machine that ran it, so restoring it from another machine's snapshot (or from an older snapshot after a reverse cutover) would make PortOS refuse its own healthy database with `DATABASE_RETIRED_BACKEND`, including after a restart. Every file restore therefore excludes it, in preview and execution alike, and the integrity preflight ignores it too. The destination's existing file stays byte-for-byte as it was: an absent record stays absent and a damaged one stays fail-closed. Other records in the snapshot restore normally. Selecting `database-authority.json` itself is refused with `BACKUP_RESTORE_MACHINE_LOCAL` before anything is transferred. This does not touch an active maintenance journal (`database-maintenance/`): its recovery semantics are unchanged, and another machine's cutover endpoints are never imported. To change which backend is authoritative, run a database cutover.

### Database — `restorePostgres()`

Replays the snapshot's `portos-db.sql` into the live database via `psql -v ON_ERROR_STOP=1 --single-transaction`, so the **SQL replay is atomic**: a failed replay rolls back.

**Client/server compatibility (#9925).** Preview and execution check the target PostgreSQL major version. A PG17-client dump made from PG16 can be replayed to PG16: the private replay copy omits only the exact top-level `SET transaction_timeout = 0;` header, which [PostgreSQL 17 introduced](https://www.postgresql.org/docs/17/release-17.html). PG17+ targets retain it. COPY rows, quoted functions/strings, comments, and psql `\restrict` / `\unrestrict` commands remain intact. Source bytes, manifest hashes and recovery receipts are unchanged; extension normalization and transactional rollback remain in effect. An unresolvable target major returns `restore_compatibility` with a connectivity/version-check instruction before mutation. This narrow compatibility fix does not make arbitrary newer SQL features portable to older servers.

**Dump admission (#8782).** Because the replay starts by resetting every application table, a dump that parses but stops early would commit an empty database — `ON_ERROR_STOP` cannot see a file that simply ends between complete statements, and historical snapshots carry no checksum to catch it. Before preview or execution perform reset preflight or mutations, PortOS streams the dump once and requires the plain `pg_dump` envelope: the terminal `-- PostgreSQL database dump complete` block as the last content (only the `\unrestrict` line newer `pg_dump` writes may follow it) and the `CREATE TABLE` definitions for `memories` and `memory_links`, which every PortOS dump has contained. Tables introduced later are not required, and a complete dump of empty tables is valid. A header-only or truncated dump is refused as `dump_incomplete`, and a read failure as `dump_unreadable` — never as an empty successful restore. The same streamed read supplies the manifest checksum. For execution it also writes the bytes it checked to an owner-only copy in a fresh `portos-restore-*` directory under the OS temp dir, and `psql` replays that copy rather than the snapshot path, so a dump that changes on the backup media after admission cannot be what gets restored. The copy is removed when the restore finishes, whatever the outcome; staging it needs free temp space about the size of the dump. After replay commits, PortOS forces the current additive schema upgrades and then runs ordered DB migrations using the restored `schema_migrations` ledger. Already-applied migrations are skipped. Success is returned only after both phases finish and peer sync is repaired (below); dry-run performs neither replay nor schema changes.

| Result | Meaning |
|---|---|
| `{ status: 'ok', dryRun, sizeBytes, tableCount }` | Dry-run report, or a successful real restore (which adds `syncCursorsRewound`, the number of peers rewound) |
| `{ status: 'skipped', reason: 'no_dump' }` | No `portos-db.sql` in the snapshot (or 0 bytes) |
| `{ status: 'skipped', reason: 'not_configured' }` | Real restore requested but Postgres is unreachable — refuses to half-restore |
| `{ status: 'failed', reason: 'manifest_unreadable' }` | An existing `manifest.json` is corrupt or unreadable — choose another snapshot or repair the backup media before retrying |
| `{ status: 'failed', reason: 'manifest_mismatch' }` | Snapshot's `portos-db.sql` hash disagrees with `manifest.json` — dump considered untrustworthy |
| `{ status: 'failed', reason: 'dump_unreadable', error }` | `portos-db.sql` could not be read, or its private restore copy could not be written — refused before any reset |
| `{ status: 'failed', reason: 'dump_incomplete', error }` | The dump lacks the `pg_dump` completion marker or a core PortOS table (header-only or truncated) — refused before any reset |
| `{ status: 'failed', reason: 'restore_compatibility', error }` | Target PostgreSQL major cannot be established — repair the version check and retry preview before execution |
| `{ status: 'failed', reason: 'restore_journal', error }` | The recovery journal could not be written — refused before any reset |
| `{ status: 'failed', reason: 'backup_snapshot_busy', error }` | A backup cut is active, or admitted asset publications did not drain — refused before the recovery journal or any reset; retry later |
| `{ status: 'failed', reason: 'restore_error' \| 'timeout', error }` | `psql` replay failed (stderr captured) and was **proven rolled back** from its receipt (below) |
| `{ status: 'failed', reason: 'restore_commit_unknown', error, recovery }` | `psql` did not report success and the receipt could not settle whether the replay committed — recovery pending |
| `{ status: 'failed', reason: 'restore_schema_reconciliation', error, recovery }` | The dump committed, but current schema recovery failed; **not rolled back**, recovery pending |
| `{ status: 'failed', reason: 'restore_sync_resync', error, recovery }` | The dump committed and the schema recovered, but peer sync could not be repaired (below) — recovery pending |
| `{ status: 'failed', reason: 'restore_recovery_release', error, recovery }` | Repair finished but the journal could not be cleared — recovery pending |
| `{ status: 'failed', reason: 'restore_recovery_pending', error, recovery }` | An earlier restore is still awaiting recovery; preview and replay are refused |

**Peer sync repair (#8710).** Memories and the seven Catalog tables federate through per-stream feed positions. A restore breaks both directions: this install's per-peer pull cursors (`data/instances_sync_cursors.json`) still point past rows the restore discarded, and the dump rewinds each `<table>_sync_feed_seq`, so new rows would reuse positions peers have already passed. Inside the maintenance window, the restore records each feed sequence before replay. After reconciliation, it sets each sequence back to at least that value and rewinds every peer's `memorySeq` and `catalogSeqs` to `0`. Brain cursors and snapshot checksums are left alone. The next sync replays each peer's streams through the idempotent last-writer-wins apply paths. A sync already in flight during the restore does not save its pre-restore cursor positions. Dry-run and failed restores change neither cursors nor sequences.

**Committed-restore recovery (#9725).** A replay that commits but whose repair then fails must neither reopen ordinary writes nor be replayed again — the next sequence value would reuse positions peers already passed, inbound cursors would still skip discarded rows, and a repeated restore would also delete anything accepted after the first replay. So, inside the maintenance window and **before** the destructive replay, the restore publishes a durable journal at `data/database-restore-recovery.json` holding a fresh operation id, the admitted dump's SHA-256, the ORIGINAL feed-sequence positions and the pending stage (`replaying`). The `psql` replay appends one `restore_receipts` row for that operation id after the dump, inside the same transaction, and runs with `application_name = portos-restore-<id>`.

- While the journal exists, every ordinary database operation in the server is refused with `503 DATABASE_RESTORE_RECOVERY` (`server/lib/db.js`); only the maintenance context that owns that operation may inspect or repair. The fence survives restart.
- `psql` exit 0 means the replay committed (stage `repairing`). Any other outcome — an SQL error, a timeout kill, a lost connection at `COMMIT` — is settled from the receipt: no live `portos-restore-<id>` session and no receipt is a **proven rollback**, which clears the journal and reopens admission with current rows intact; a receipt is a commit; anything else (a replay session still alive, an unreachable database) stays fenced as `restore_commit_unknown`.
- Repair runs forced schema upgrades, ordered migrations, feed-sequence flooring at the **recorded** positions (never re-read after the replay) and the inbound cursor rewind. All steps are idempotent. Admission reopens only after every step succeeds, the journal is removed, and its parent directory is synced.
- If journal unlink fails, the durable record remains pending. If unlink succeeds but directory sync fails, the journal instance retains the operation and original feed positions in memory: status and ordinary database admission stay pending, and same-operation recovery retries finish directory sync. On a fresh process, a surviving journal invokes idempotent repair; if deletion persisted, completed repair needs no destructive replay. This process-local retry cannot provide stronger crash guarantees than the filesystem.
- **Resume**, never repeat. Settings → Backup shows the pending operation with a **Resume recovery** action (`POST /api/backup/restore-db/recover` with the operation `id`), and `GET /api/backup/status` reports it as `restoreRecovery`. Restarting PortOS resumes it automatically before any route, scheduler or writer loads (`server/start.js`); if recovery still fails, boot is refused with the reason in the server log and the fence stays closed. Recovery never runs the reset or the dump again, and starting another restore is refused (`restore_recovery_pending`) until this one finishes.
- An unreadable or damaged journal fails closed: the database stays fenced and boot is refused. Inspect the file and the logs; do not delete it unless you have established how the restore ended (with the database reachable, `SELECT * FROM restore_receipts WHERE operation_id = '<id>'` answers whether it committed).

Reconciliation can partially apply upgrades; it is separate from the completed replay transaction, which is why it is retried rather than rolled back.

A non-dry-run restore requires a reachable DB first (`checkHealth()`), so a restore never half-applies against a down database.

### Backend export / sync — `POST /api/database/sync`

Separate from snapshot restore: `server/routes/database.js` can copy data **between** the native (port 5432) and Docker (port 5561) Postgres backends. It exports the active backend with `pg_dump`, ensures the target backend has the `portos` role/database/extensions, then imports under `ON_ERROR_STOP=1 --single-transaction`. `POST /api/database/export` produces an on-demand dump under `data/db-dumps/`. These power the Database settings tab's mode-switch/sync flows; they are independent of the rsync snapshot backups above.

## Retention & deletion

Left unbounded, `snapshots/<hostname>/` grows forever — every prior full DB dump stays reachable, so a record deleted from the live database (including `privacy_vault_records`, `privacy_consents`, and `privacy_broker_cases`) remains restorable from an old snapshot indefinitely. `server/lib/backupConfig.js` resolves a per-source `retentionCount`, and `runBackup()` prunes with it after a successful database dump, or when the explicit file-backend escape hatch skips the dump (`pruneOldSnapshots()` in `backup.js`). A degraded run whose database dump failed skips pruning and logs a warning, preserving older snapshots until a later dump succeeds.

- **New installs default to 30 completed snapshots per source.** The default ships as `backup.retentionCount: 30` in `data.reference/settings.json`, copied only into an install that has no `data/settings.json` yet — see the comment on `resolveRetentionCount()` for why this, not a migration, is what keeps an existing install from silently losing its archive. Operators choose 1–365, or Unlimited, from the Backup settings tab.
- **`retentionCount` absent or explicitly `null` both mean unlimited** — no pruning runs. This is why an install that predates this setting keeps every snapshot until the operator saves a choice: it has no stored value, and absence resolves to unlimited, not to the new-install default.
- **Pruning runs only after a run reaches a completed snapshot with a usable database dump** (`pg_dump` succeeded, or was explicitly skipped by the file-backend escape hatch). A degraded run whose database dump failed keeps older snapshots and reports zero pruned snapshots; retention resumes after a later successful dump. A run that fails before completion never prunes, and a prune failure is logged without failing an otherwise-successful backup.
- **Pruning is scoped to the CURRENT machine's namespace** (`snapshots/<hostname>/`) and only ever deletes snapshots whose `snapshotState()` reports neither `incomplete` nor `failed`. It never touches another machine's namespace in a shared destination, the legacy pre-namespace root, or an in-progress/failed snapshot — those stay until the operator deletes them explicitly.
- **`DELETE /api/backup/snapshots/:snapshotId?source=<source>`** (`backup.deleteSnapshot()`) permanently removes exactly the selected source/ID pair, immediately — there is no undo and it is never automatic. It shares `resolveSnapshotPath()`'s path-traversal and symlink guards with restore/download, and refuses a snapshot that is still being written (`SNAPSHOT_INCOMPLETE`); unlike restore, a `.failed` snapshot **is** deletable. The Backup settings tab's snapshot history exposes this as a per-row delete action behind a confirmation dialog.

## Scheduling & status

- Daily backups are driven by `backupScheduler.js` via the `backup-daily` cron event; `getNextRunTime()` reports the next run.
- **The registration tracks settings — no restart needed.** `syncBackupSchedule()` runs at boot *and* on every settings save (subscribed to `settingsEvents`' `settings:updated`), so enabling backups or setting `destPath` when scheduling was previously inactive registers the cron immediately, editing `cronExpression` re-registers it, and disabling backups (or clearing `destPath`) cancels it. A save that doesn't change the registration inputs (cron expression, timezone, active/inactive) is a no-op — `destPath` and the exclude lists are re-read by the handler per run, so changing them never churns the registration.
- `GET /api/backup/status` surfaces the persisted state including the last `pgBackup` outcome, so the Backup settings tab shows whether the last DB dump succeeded, its size, and table count.

### Omitted schedule fields

The backup settings slice is stored **sparsely** — an install where the user only ever typed a destination has no `enabled` and no `cronExpression` on disk. `server/lib/backupConfig.js` is the single module that says what those omissions mean, and every consumer resolves through it:

| Stored | Effective |
| --- | --- |
| `enabled` absent | **enabled** — an omitted toggle has never meant "off" on the server, and changing that would silently stop nightly backups on existing installs |
| `cronExpression` absent or blank | `0 0 * * *` (midnight, in the user's timezone) |
| `destPath` absent or blank | **nothing is scheduled**, whatever `enabled` says |
| `retentionCount` absent or `null` | **unlimited** — nothing is pruned. A NEW install ships an explicit `30` in `data/settings.json` (see [Retention & deletion](#retention--deletion)); an existing install's absence is never reinterpreted as that default. |

`GET /api/settings` projects these effective values over the stored slice, so the Backup settings tab renders exactly what the scheduler will do. **The client owns no fallback of its own** — it used to read the same sparse config as "disabled at 02:00" while the scheduler read it as "enabled at midnight", so saving an unrelated preference wrote that misreading back and cancelled a live schedule (#6632). If a settings response ever arrives without a resolved schedule the tab shows a load error instead of a form, rather than saving invented values.

This is **read-time resolution only**: nothing on disk changes, sparse configurations stay valid, and older clients can keep submitting the same partial shape.

## See also

- [Storage Classification Contract](./STORAGE.md) — which data lives in Postgres vs files (and therefore which half of a snapshot captures it).
- [`docs/superpowers/specs/2026-06-05-verified-pg-backup-design.md`](./superpowers/specs/2026-06-05-verified-pg-backup-design.md) — design rationale for verified, restorable DB backups.

### Restoring an older database snapshot

Database restore is a **full replacement**, not a merge. It removes current
PortOS tables, functions and sequence state before replaying the snapshot,
including tables introduced after the backup. Current schema upgrades and
ordered migrations then recreate newer tables consistently without retaining
post-snapshot records. The public namespace's owner and permissions are retained.

Preview performs read-only ownership/object/dependency checks. Unknown objects
or external dependencies refuse the restore; the reset uses `RESTRICT`, never
an unrestricted cascade. Reset and dump replay share one PostgreSQL transaction
with `ON_ERROR_STOP`: a replay failure restores the previous rows and constraints.
Schema reconciliation follows the commit; a reconciliation failure explicitly
reports that replay committed and recovery still needs attention. Application
database operations drain before reset; new operations receive a temporary
maintenance error until replay and reconciliation finish (including failures).

### Restoring settings in a running server

Full live file restores and selective `settings.json` restores join the settings
write queue. Previously admitted mutations finish before transfer starts; later
mutations wait through transfer and cache reconciliation, then read the restored
file as their base. Partial transfer and reconciliation failures release the
queue while retaining the existing restore diagnostics. Malformed restored
settings still invalidate the cache rather than broadcasting empty defaults.
Dry runs and unrelated selective restores do not acquire this settings boundary.

A full restore acquires boundaries in this order: settings, CoS configuration, CoS
runtime state, media model registry. The settings queue remains held through CoS reconciliation. A
restore callback must never call a queued settings write API; cache reload reads
directly and does not re-enter the queue.

### Restoring CoS files in a running server

A full live file restore or selective `cos` restore requires the CoS daemon and
Persistent Mind to be stopped and active agents to be finished or stopped. The
server rejects unsafe or unreadable ownership state before rsync starts, with
`COS_RESTORE_BUSY`. Pausing the daemon alone is insufficient.

The restore drains configuration writes, then runtime-state writes, and holds
both queues through the transfer and cache reload. Both CoS caches are reloaded
and the normal configuration-change event is emitted even after a partial rsync
failure. Subsequent partial settings saves preserve restored fields. Transfer
errors still report that files may have been overwritten; a cache-reload failure
requires restarting PortOS before using CoS. Dry runs and selective restores
outside the CoS state/config scope do not acquire this boundary.

## Database maintenance admission

While the server is still running, `GET /api/database/maintenance/status` reads the journal without querying PostgreSQL or launching shell probes. It uses the ordinary instance authentication gate (authentication remains optional) and returns `{ stage: "idle", fenced: false }` when no operation exists, or the operation's `id`, `stage`, source/target mode names, and `fenced: true`. Connection identities and coordinator credentials are never returned. Responses are not cacheable; damaged or unreadable state returns HTTP 503 with `DATABASE_MAINTENANCE`, never idle. A `verified` stage alone still reports fenced: it does not authorize writers or prove admission has reopened. Once the server has stopped or its boot fence refuses startup, use the local status command below; this endpoint does not bypass the boot fence.

The persistent maintenance boundary is a prerequisite for coordinated offline migration (#8805). It does **not** migrate data, change saved mode, stop existing writer processes, or prove a target cutover. In particular, entering maintenance is not permission to invoke an uncoordinated SQL import or backend migration.

From the install root, inspect the journal with `status`. `begin` is a
**low-level, admission-only command — it does not start a migration.** It
immediately fences normal database work, launches no coordinator or worker, and
will never progress by waiting; `recover` cannot start it either, because
there is no coordinator to resume. Use Settings (Database tab) or
`POST /api/database/maintenance/cutover` to migrate. Run `begin` only when you
deliberately want the bare fence:

```sh
node scripts/database-maintenance.mjs status
node scripts/database-maintenance.mjs begin native docker
# Or, when the saved source mode is Docker:
node scripts/database-maintenance.mjs begin docker native
```

If an operation was created by `begin` alone (status shows stage `accepted`
and no `coordinator`), cancel it with the command below, using the unchanged
source configuration, before starting the complete cutover. The cutover is
refused while that ownerless fence exists.

The command returns the operation ID and direction. Plan for downtime: new pooled database operations, database administration mutations/exports, and CoS spawn admission are refused immediately, and both managed server and runner refuse normal boot while fenced. Admission is the synchronous fence check: work admitted just before publication may still obtain a connection or spawn afterward. Already-admitted transactions may finish; this boundary alone is **not a drained snapshot boundary**. The offline coordinator must still stop/drain all owned writers and validate live/spawning work before export. A process-local restore callback cannot bypass this persistent fence.

If no transfer has started and saved source configuration is unchanged, cancel using that exact ID:

```sh
node scripts/database-maintenance.mjs cancel <operation-id>
```

Cancellation supports only the initial accepted stage, preserves the journal in the machine-local cancelled archive, and never switches mode or reverses direction. Restart managed processes through the existing PM2 ecosystem workflow after cancellation if their normal boot was refused. CLI configuration follows the ecosystem's environment precedence; run from the same configured operator environment. Changed source configuration, a different operation ID, an unknown stage/version, and a competing operation are refused.

An incomplete publication or interrupted cancellation remains fenced. Do not remove the active directory, steal its cancellation claim, or guess a backend from `.env`: retain the journal for recovery. There is no rollback, force or skip command. Cancellation clears an ownerless `accepted` fence; `node scripts/database-maintenance.mjs recover <operation-id>` is a different case: it only resumes the same recorded, coordinator-owned operation (identity preserved) after its worker exited. The offline transfer, its retained `data/db-dumps/portos-maintenance-<operation-id>.sql` recovery dump, mode commit, verified restart and release are described in [offline transfer](STORAGE.md#offline-transfer) and [mode commit, verified restart, and release](STORAGE.md#mode-commit-verified-restart-and-release); Settings (Database tab) surfaces the interrupted state and its Resume control from the same journal. `data/database-authority.json` and `data/database-maintenance-completed/` are local records of a finished cutover. Snapshots keep them as recovery evidence, but a file restore never installs `database-authority.json` (see [Database authority is not restored](#database-authority-is-not-restored)), so restoring another machine's or an older backup can neither lift nor impose the retired-backend guard. Normal startup and migration must not be re-enabled by treating this preparatory operation as a completed cutover.

Coordinator stage publication uses immutable, atomically linked records. A same-operation retry with the existing owner token can confirm its last transition after a lost response; abandoned temporary files do not advance the stage, and a delayed retry cannot overwrite later progress. Interrupted claims from the older publication protocol still fail closed. This does not permit replacing a coordinator, reopening admission, or retrying SQL import: those require the offline recovery protocol.

### Verification-only server startup

The managed server entrypoint is `server/start.js`. Normal startup checks the
persistent fence before importing the application graph, so routes, migrations,
schedulers, and writer modules cannot initialize while maintenance is active.
The CoS runner retains its separate boot fence.

For an operation already at `verifying` or `verified`, a recovery operator can
run a read-only target diagnostic from the intended target launch environment:

```sh
node server/start.js --verify-database <operation-id>
```

Supply the recorded target's `PGHOST`, `PGPORT`, `PGUSER`, and `PGDATABASE` through
that environment, and credentials through `PGPASSWORD`. This direct Node command
does not load `.env`; use the same resolved values the PM2 ecosystem would pass
to the server. It checks the actual pool's captured connection settings against
the recorded target before checkout, then checks database/user identity and the
required memory/catalog schema in one read-only transaction. A stale source
port, wrong operation, earlier stage, unavailable database, incomplete schema,
or changed/damaged journal refuses the diagnostic. Raw connection errors and
credentials are omitted from its response.

Success returns `targetHealthy: true` and `fenced: true`, then closes the pool
and exits. Repeating the command repeats the probe without changing any journal
stage. It never imports the application, clears the fence, rewrites saved mode,
or resumes writers. This is **not completed cutover or proof of a later ordinary
restart**. The offline coordinator still must own shutdown/drain, transfer,
interruption recovery, and a verified admission-release handshake (#8816).
Do not advance journal stages manually to make this diagnostic run; unsupported
or damaged operations must stay fenced with both database copies preserved.

### Restoring the media model registry in a running server

A full live file restore or a selective `media-models.json` restore fences the
cached media registry (`withLiveMediaModelsRestore` in `server/lib/mediaModels.js`).
From the moment the restore is requested, availability toggles, adds, patches and
removes are refused with `MEDIA_MODELS_RESTORE_BUSY` before any disk or cache
change; competing restores are serialized. After the transfer — including a
partial rsync failure — the registry is reloaded from the resulting file before
the fence is released, so a later toggle can no longer write the pre-restore
registry back over the restored one. If the reload cannot read the file, edits stay
refused with `MEDIA_MODELS_UNAVAILABLE` until a later restore reconciles it or
PortOS restarts. Dry runs and unrelated selective restores do not acquire this
boundary.
