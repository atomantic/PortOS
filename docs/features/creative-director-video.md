# Standalone Video production in Creative Director

Commission a standalone video from **Creative Director → New video draft**.
Create → Video remains the existing creative-commission video browser. Existing
Video Gen, remix/continue and Creative Director links continue to work. No Series
is required. Saving or opening a draft makes no generation calls.

## Workflow

1. Enter the brief, duration range, aspect, quality and optional creative sources.
   The displayed exact target is retained within that range. Sources are read
   into the local planning context; deleted or changed sources block stale work.
2. Choose the media backend and cognitive models. Treatment and production-plan
   stages require a configured agent harness; evaluation can use a configured
   vision model. Stage provider/model/effort choices survive reload. Explicit
   Video backends do not fall back to a different provider. Reactor readiness
   does not depend on local model hardware.
3. Select an audio contract: silent, native audio in every clip, an existing
   Music track, or one generated soundtrack bed. Generated audio names a local
   engine, model and prompt. An unavailable engine blocks Start. A short bed
   repeats through Timeline to cover the cut, within its 20-track lane limit;
   choose a longer track if it would require more repetitions. Soundtracks
   replace clip audio. Native audio does not promise dialogue or lip sync.
4. Review the resolved choices and explicit clip, audio-job, agent-call, retry
   and replan limits, then select **Start production**. Counts include previous
   attempts. Provider prices and balances can be unknown; an optional dollar
   cap blocks calls without enforceable pricing rather than claiming a budget
   guarantee. No Reactor balance endpoint is assumed.
5. The treatment becomes a revisioned script and timed shot artifact. Review
   mode gates script/shot plan, references, rough cut and final cut at the saved
   checkpoints. Autonomous mode skips human decisions after artifacts exist.
   Thumbs and notes are optional feedback; they do not approve or dispatch work.
6. Accepted shots (or completed bounded video-plan steps) enter the existing
   Timeline renderer. The output includes all required clips, trims excess at
   the exact target, and supports straight cuts or fades through black. These
   fades do not overlap shots or shorten the timeline. Clips too short for
   their planned timing block assembly; missing shots cannot silently disappear.
7. The rough cut is playable before approval. Final review uses the same
   validated cut unless a revision changes it. Delivery requires an existing
   playable file, verified video stream, the chosen audio contract, and duration
   within both the saved range and one output frame of the exact target.
   Missing ffprobe, unreadable media, incorrect timing or missing requested
   audio cannot produce a completed project.
8. Play or download the final video, open Media History, the project collection,
   or its reusable Timeline. Soundtrack placements remain in that Timeline;
   generated beds also become standalone Music Tracks. Previous cuts and partial
   clips stay accessible after revisions.

## Pause, review and recovery

Pause and Stop revoke authorization before canceling owned agents, render jobs
and Timeline assembly where supported. A provider may already have accepted or
charged for work that cannot be confirmed canceled. Such submissions remain
uncertain and require queue reconciliation or explicit retry consent.

Restart reads receipts and completed outputs without starting new provider work.
Resume reconciles stored job/task IDs first, reuses completed assets and applies
the reviewed limits. Settings can be edited while a Video project is draft,
paused or failed; creative edits invalidate dependent review revisions.
Approving an obsolete revision is rejected, and late callbacks cannot overwrite
newer work. An assembly failure keeps partial media and provides a visible reason
with links to repair settings, review artifacts, inspect queues or open Timeline.

Execution authority belongs to the creating install. Synced replicas cannot
start a second production. See [Storage](../STORAGE.md) for JSONB, file assets,
backup and cross-version gates. Legacy generalized Creative Director projects
retain their prior behavior.

## Verification without provider charges

`server/services/creativeDirector/videoAssembly.test.js` creates synthetic
multi-shot Reactor-like results, then exercises the real Timeline/ffmpeg boundary,
including trimming, audio preservation, distinct cut approvals and validation
failures. It makes no AI-provider calls. Tests require local ffmpeg/ffprobe and
skip that real media exercise when they are unavailable. Other execution tests
use fake queues, task providers and audio generation. DB-backed tests run only
against `portos_test` through the documented test command.

## Optional real-render smoke test

Run this only when deliberately choosing to spend provider credits; it is never
part of boot or CI. Configure the intended backend credentials and eligible
cognitive stages. Create a fresh standalone Video draft for a 60–180 second
animated woodland short, select Reactor, set silent audio (or explicitly choose
a soundtrack), and keep review mode enabled. Verify the exact target and resolved
providers before Start; set a clip bound sufficient for that target plus only
the retries you intend to fund. Leave the dollar cap unset only if accepting
unknown cost with the displayed call bounds.

Approve the current script and references, inspect one rendered shot and queue
receipt, then pause. Confirm no new job is submitted while paused. Resume, approve
the actual rough and final cuts, and play/download the delivered file. Confirm its
duration, requested audio, separate assembled media ID, collection entry and
Timeline placements. Optionally restart while paused and verify it remains paused.
An uncertain submission requires inspecting the provider/queue and explicit retry
consent; do not rerun blindly. Delete or archive only this smoke project's assets
when finished.
