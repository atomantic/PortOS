import { isAudioToVideoRuntime } from './runnerFamilies';

// One enqueue policy for Video Gen's Generate button, "Add to queue" button and
// the Options caption. Each row says WHEN it applies (`scope`), whether it is
// disabling right now (`active`), the title it gives the buttons (`reason`),
// and the caption shown beside Options (`optionsHint`). The first disabling row
// wins for each surface, so the order below is the precedence.
//
// scope: 'always' rows apply to every target; 'remote' rows to a federated peer
// target; 'local' rows only to a render that runs on this machine. A render an
// external API owns (Grok, fal.ai, reactor.inc) skips every local row, so a
// local model left selected after a backend switch can no longer gate it.

const QUEUE_READY = 'Submit this configuration to its server queue; local, Grok, and remote lanes run independently';
const QUEUE_GENERIC = 'Complete the required inputs before queueing';

// Why an audio-to-video render cannot start yet, in the order the user can fix it.
const a2vBlockReason = ({ a2vDurationError, modelRuntime, audioFile }, verb = 'generating') => {
  if (a2vDurationError) return a2vDurationError;
  if (!isAudioToVideoRuntime(modelRuntime)) return 'a2v mode requires an audio-to-video model — pick one from the Model dropdown';
  if (!audioFile) return `Pick an audio file before ${verb}`;
  return `Pick a reference image before ${verb} with this model`;
};

const byovReason = ({ byovRuntimeMissing, byovLabel, byovRuntime }) => (byovRuntimeMissing
  ? `${byovLabel || byovRuntime} runtime is not installed — use the install banner above`
  : `Checking ${byovRuntime} runtime status…`);

const ENQUEUE_ROWS = [
  { scope: 'always', active: (c) => !c.promptOptional && !c.prompt.trim() },
  { scope: 'always', active: (c) => c.remixHandoffPending },
  { scope: 'always', active: (c) => c.promptOverLimit },
  { scope: 'remote', active: (c) => !!c.remoteBlocked, reason: (c) => c.remoteBlocked },
  { scope: 'local', active: (c) => c.notConnected },
  { scope: 'local', active: (c) => c.byovGateBlocked, reason: byovReason },
  {
    scope: 'local',
    active: (c) => !!c.blockedAsset,
    reason: (c, verb) => `Download the ${c.blockedAsset.label} before ${verb}`,
    optionsHint: (c) => `Open Options to download the ${c.blockedAsset.label}`,
  },
  {
    scope: 'local',
    active: (c) => c.extendModeBlocked,
    reason: (_c, verb) => `Pick a prior render and wait for the last frame to extract before ${verb}`,
    optionsHint: () => 'Open Options to pick a prior render and wait for its last frame',
  },
  {
    scope: 'local',
    active: (c) => c.a2vModeBlocked,
    reason: a2vBlockReason,
    optionsHint: (c) => `Open Options: ${a2vBlockReason(c)}`,
  },
  {
    scope: 'local',
    active: (c) => c.icLoraModeBlocked,
    reason: (_c, verb) => `Add the reference media required by this mode before ${verb}`,
    optionsHint: () => 'Open Options to add the reference media required by this mode',
  },
  {
    scope: 'local',
    active: (c) => c.keyframesBlocked,
    reason: (c) => c.keyframesError,
    optionsHint: (c) => `Open Options: ${c.keyframesError}`,
  },
];

/**
 * Decide whether a video render can be enqueued and what to tell the user.
 * Returns `{ canEnqueue, generateTitle, queueTitle, optionsHint }`; the titles
 * and caption describe the first disabling row (`generateTitle` is `undefined`
 * and `optionsHint` is `null` when that row has nothing specific to say).
 */
export function videoGenEnqueuePolicy(ctx) {
  const target = ctx.isRemote ? 'remote' : ctx.rendersOffMachine ? 'offMachine' : 'local';
  const blocking = ENQUEUE_ROWS.filter((row) => (row.scope === 'always' || row.scope === target) && row.active(ctx));
  const first = blocking[0];
  const generateReason = first?.reason?.(ctx, 'generating');
  const hinted = blocking.find((row) => row.optionsHint);
  return {
    canEnqueue: blocking.length === 0,
    generateTitle: generateReason || undefined,
    queueTitle: first ? first.reason?.(ctx, 'queueing') || QUEUE_GENERIC : QUEUE_READY,
    optionsHint: hinted ? hinted.optionsHint(ctx) : null,
  };
}
