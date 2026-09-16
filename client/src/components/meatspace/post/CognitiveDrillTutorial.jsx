import { useEffect, useRef, useState } from 'react';
import { BookOpen, Check, Pause, Play } from 'lucide-react';
import { DRILL_LABELS, effectiveCognitiveDrillConfig, cognitiveRungPending } from './constants';
import usePrefersReducedMotion from '../../../hooks/usePrefersReducedMotion';
import { useVisibilityEvent } from '../../../hooks/useVisibilityEvent.js';
import { pluralize } from '../../../lib/textUtils.js';
import { safeReadJsonStorage, safeWriteStorage } from '../../../lib/safeStorage.js';
import Modal from '../../ui/Modal';

/**
 * The how-to material for the cognitive drills: the per-type tutorial
 * copy, the n-back worked example, the card that renders them, and the two
 * entry points that open it (the standalone preview and its button).
 *
 * Deliberately separate from PostCognitiveDrillRunner: this is help text with
 * no scoring, no stimulus generation and no provider calls, and the
 * settings/launcher surfaces that link to it (PostDrillConfig,
 * PostSessionLauncher) have no business importing a live drill runner to reach
 * it. The runner keeps only `DrillTutorialGate`, which gates its own mount and
 * imports the card from here. The one timer in this module drives the n-back
 * demo loop — it animates an explanation and records nothing.
 */

// One JSON blob keyed by drill type. Reads/writes go through the shared
// safeStorage helpers so a missing/blocked/corrupt store (SSR, Safari private
// mode) can never crash the `useState` initializer that reads it — a storage
// failure just means the tutorial shows again.
const DRILL_TUTORIAL_SEEN_KEY = 'portos.post.drillTutorialSeen';

function loadSeenTutorials() {
  const parsed = safeReadJsonStorage(DRILL_TUTORIAL_SEEN_KEY, {});
  return parsed && typeof parsed === 'object' ? parsed : {};
}

export function hasSeenDrillTutorial(type) {
  return loadSeenTutorials()[type] === true;
}

export function markDrillTutorialSeen(type) {
  const seen = loadSeenTutorials();
  if (seen[type]) return;
  seen[type] = true;
  safeWriteStorage(DRILL_TUTORIAL_SEEN_KEY, JSON.stringify(seen));
}

// Distinct letters for the n-back worked example — an example runs n+3 long, so
// this covers every lag a drill will ever ask for and no letter repeats by
// accident (which would read as a second, unlabeled match).
const NBACK_EXAMPLE_LETTERS = 'KRTMPQBHLSDFGJNVWXYZ';

/**
 * A tiny worked n-back stream for the tutorial: distinct letters, with the LAST
 * one repeating the letter `n` steps back so there is exactly one match to point
 * at. Returns the data the example strip renders, not markup, so it stays
 * testable alongside the rest of `getDrillTutorial`. The match is always the
 * final letter, so the strip derives the two highlighted positions from `n`.
 */
export function buildNBackExample(n) {
  const lag = Math.max(1, Math.min(n, NBACK_EXAMPLE_LETTERS.length - 3));
  const sequence = NBACK_EXAMPLE_LETTERS.slice(0, lag + 3).split('');
  sequence[sequence.length - 1] = sequence[sequence.length - 1 - lag];
  return { sequence, n: lag };
}

/**
 * Whether a drill type has a how-to card at all. The one predicate that owns
 * this rule: a "How it works" affordance must not render for a type
 * `getDrillTutorial` has no case for, or it opens nothing.
 */
export function hasDrillTutorial(type) {
  return getDrillTutorial({ type }) != null;
}

/**
 * Drill types whose how-to copy actually VARIES with the drill config — the
 * n-back lag, the digit-span recall direction, the reaction-time mode. Only
 * these need the effective (ladder) config resolved before the card can be
 * shown; every other card reads the same at any difficulty, so it opens
 * immediately. Guarded by a property test that probes `getDrillTutorial` with
 * two configs, so a new config-dependent branch can't be added without landing
 * on this list.
 */
export const CONFIG_DEPENDENT_TUTORIAL_TYPES = ['n-back', 'digit-span', 'reaction-time'];

// Per-type how-to content. A pure function of the drill so config-dependent
// copy (n-back lag, digit-span direction, reaction-time mode) reads correctly.
// Returns null for types with no tutorial (which skip the gate entirely).
export function getDrillTutorial(drill) {
  const cfg = drill?.config || {};
  switch (drill?.type) {
    case 'n-back': {
      const n = cfg.n ?? 2;
      const step = pluralize(n, 'step');
      return {
        goal: `Watch a stream of letters and catch when one repeats from ${step} earlier.`,
        steps: [
          'Letters appear one at a time, then vanish.',
          `Compare each letter to the one ${step} back in the stream.`,
          'When they match, hit Match right away. If it doesn’t match, do nothing.',
        ],
        controls: 'Tap Match, or press Space / Enter.',
        nBackExample: buildNBackExample(n),
      };
    }
    case 'digit-span': {
      const backward = cfg.direction === 'backward';
      return {
        goal: `Memorize a run of digits, then type them ${backward ? 'in reverse' : 'back in order'}.`,
        steps: [
          'Digits flash one at a time, then the sequence ends.',
          `Type the digits ${backward ? 'in reverse order — last shown first' : 'in the order they appeared'}.`,
          'Each round adds one more digit. Submit with Enter.',
        ],
        controls: 'Type the digits and press Enter (or Skip to pass).',
      };
    }
    case 'stroop':
      return {
        goal: 'Name the ink color of a word — not what the word says.',
        steps: [
          'A color word appears, printed in some ink color.',
          'Pick the button matching the INK color, ignoring the word itself.',
          'Move fast, but let the color win over the reading reflex.',
        ],
        controls: 'Tap a color, or press its number key (1–4).',
      };
    case 'schulte-table':
      return {
        goal: 'Find the numbers in ascending order across a shuffled grid.',
        steps: [
          'A grid of scrambled numbers appears.',
          'Tap 1, then 2, then 3… in order.',
          'Keep your gaze near the center and scan — speed is the point.',
        ],
        controls: 'Tap each number in sequence.',
      };
    case 'mental-rotation':
      return {
        goal: 'Spot the shape that is the same as the target, just rotated.',
        steps: [
          'A target shape is shown up top.',
          'One option below is that shape turned to a new angle; the rest are mirrored or different.',
          'Pick the pure rotation — not a mirror image.',
        ],
        controls: 'Tap an option, or press its number key (1–4).',
      };
    case 'reaction-time': {
      const choice = cfg.mode === 'choice';
      return {
        goal: choice ? 'React to the box that lights up — as fast as you can.' : 'React the instant the signal fires.',
        steps: choice
          ? [
            'Wait while the boxes stay dim.',
            'At a random moment, one box lights up green.',
            'Press that box’s number immediately — don’t jump early or it counts as a false start.',
          ]
          : [
            'Wait while the circle stays gray.',
            'At a random moment it turns green and reads “GO!”.',
            'Press Space (or tap) the instant it does — don’t jump early or it counts as a false start.',
          ],
        controls: choice ? 'Number keys, or tap the lit box.' : 'Space / Enter, or tap.',
      };
    }
    case 'task-switching':
      return {
        goal: 'Use the rule cue to classify each stimulus, switching rules when the cue changes.',
        steps: [
          'Read the rule cue first: color, shape, or fill.',
          'When the stimulus appears, answer using only that rule and ignore its other attributes.',
          'Rule changes and conflicting attributes are deliberate — accuracy comes before speed.',
        ],
        controls: 'Tap Left / Right, or press the Left / Right arrow key.',
      };
    case 'go-no-go':
      return {
        goal: 'Respond to go signals and withhold your response to no-go lures.',
        steps: [
          'A symbol appears briefly on every trial.',
          'Tap or press Space for the filled-circle go signal.',
          'Do nothing for a square or ringed-circle lure; the next trial advances at the deadline.',
        ],
        controls: 'Tap the signal, or press Space / Enter. Withhold on no-go.',
      };
    case 'flanker':
      return {
        goal: 'Report the center arrow while ignoring the surrounding arrows.',
        steps: [
          'A row of arrows appears.',
          'Answer the direction of the center arrow only.',
          'The outer arrows may agree or conflict; keep attention on the center.',
        ],
        controls: 'Tap Left / Right, or press the Left / Right arrow key.',
      };
    default:
      return null;
  }
}

/**
 * The how-to card for one cognitive drill type. Everything around the card body
 * is caller-supplied so one component serves both entry points: the first-run
 * gate (drill header, "Start drill", the one-shot footnote) and the standalone
 * preview below (no header, "Got it", no run behind it). Keeping the body in one
 * place is the point — the n-back worked example must not drift between them.
 */
export function CognitiveDrillTutorial({ drill, tut, header = null, onAction, actionLabel, ActionIcon, footNote = null }) {
  return (
    <div className="max-w-lg mx-auto space-y-6">
      {header}

      <div className="rounded-xl border border-rose-500/30 bg-rose-500/5 p-5 space-y-4">
        <div className="flex items-center gap-2 text-rose-300">
          <BookOpen size={18} />
          <h3 className="text-lg font-semibold">{DRILL_LABELS[drill.type] || drill.type}</h3>
          <span className="ml-auto text-[0.65rem] uppercase tracking-wide text-rose-400/70">How it works</span>
        </div>

        <p className="text-sm text-gray-300">{tut.goal}</p>

        <ol className="space-y-2">
          {tut.steps.map((stepText, i) => (
            <li key={i} className="flex gap-3 text-sm text-gray-300">
              <span className="flex-shrink-0 w-5 h-5 rounded-full bg-rose-500/20 text-rose-300 text-xs font-semibold flex items-center justify-center">
                {i + 1}
              </span>
              <span>{stepText}</span>
            </li>
          ))}
        </ol>

        {tut.nBackExample && <NBackDemo example={tut.nBackExample} />}

        <p className="text-xs text-gray-500">
          <span className="text-gray-400 font-medium">Controls:</span> {tut.controls}
        </p>
      </div>

      <button
        type="button"
        onClick={onAction}
        autoFocus
        className="w-full px-6 py-4 bg-rose-500/20 hover:bg-rose-500/30 text-rose-200 border border-rose-500/40 font-semibold rounded-lg transition-colors flex items-center justify-center gap-2"
      >
        <ActionIcon size={18} /> {actionLabel}
      </button>

      {footNote && <p className="text-center text-xs text-gray-600">{footNote}</p>}
    </div>
  );
}

/**
 * Standalone how-to card for a drill type, with no runner behind it — the way
 * back to a tutorial once its one-shot first-run gate has been spent (issue
 * #4732). Rendered from the POST launcher and the drill config so a rule you
 * last read weeks ago is re-readable without starting a scored run.
 *
 * Deliberately NOT reachable from inside a live drill: every cognitive runner
 * stamps `startedAtRef` at mount, so re-showing the tutorial mid-run would
 * either drop the run or bill the reading time to its `totalMs`. The preview
 * takes a plain `{ type, config }` and mounts no runner at all.
 *
 * `drill` may be null (nothing selected) or a type with no tutorial — both
 * render nothing, so callers can pass state straight through.
 */
export function CognitiveDrillTutorialPreview({ type, drillConfig, cognitiveProgress, onClose }) {
  // Both the effective config and the "can we show it yet?" question are decided
  // HERE, not at each call site: the two surfaces would otherwise each carry
  // (and each get to drift on) the same three-way derivation.
  const drill = type ? { type, config: effectiveCognitiveDrillConfig(drillConfig, cognitiveProgress?.[type]) } : null;
  const tut = drill ? getDrillTutorial(drill) : null;
  if (!tut) return null;
  const label = DRILL_LABELS[type] || type;
  const pending = CONFIG_DEPENDENT_TUTORIAL_TYPES.includes(type)
    && cognitiveRungPending(type, drillConfig, cognitiveProgress);
  if (pending) {
    // The rung that decides this drill's lag / recall direction hasn't loaded.
    // Waiting beats rendering the stored knobs, which would state one rule and
    // then swap it for another mid-read.
    return (
      <Modal open onClose={onClose} size="md" usePortal ariaLabel={`How ${label} works`}>
        <div className="bg-port-card border border-port-border rounded-xl p-5 text-center text-sm text-gray-400" role="status">
          Resolving your current {label} difficulty…
        </div>
      </Modal>
    );
  }
  return (
    // `usePortal` per the overlay convention in client/src/AGENTS.md: this is
    // rendered mid-tree inside two long settings/launcher pages, and a
    // `backdrop-filter` ancestor (every bordered `.bg-port-card` on the glass
    // themes) would otherwise become the fixed overlay's containing block.
    // Sized `md` to match the card body's own `max-w-lg`, so there is no dead
    // gutter inside the panel.
    <Modal open onClose={onClose} size="md" usePortal ariaLabel={`How ${label} works`}>
      <div className="bg-port-card border border-port-border rounded-xl p-5 max-h-[85vh] overflow-y-auto">
        <CognitiveDrillTutorial
          drill={drill}
          tut={tut}
          onAction={onClose}
          actionLabel="Got it"
          ActionIcon={Check}
          footNote="Preview only — nothing is timed or scored here."
        />
      </div>
    </Modal>
  );
}

/**
 * The affordance that opens the preview. Shared by the POST launcher sidebar and
 * the Drill Config cards so the accessible name (`How <label> works`, which both
 * suites assert) and the mobile hit area live in ONE place rather than drifting
 * per surface. Renders nothing for a type with no how-to card, so the button can
 * never open an empty modal.
 *
 * `compact` is the launcher's dense sidebar row: icon only, with the 44px touch
 * target collapsing to a tight icon on `sm+`.
 */
export function CognitiveDrillHowItWorksButton({ type, onClick, compact = false }) {
  if (!hasDrillTutorial(type)) return null;
  const label = DRILL_LABELS[type] || type;
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`How ${label} works`}
      title="How it works"
      className={compact
        ? 'shrink-0 inline-flex items-center justify-center min-w-[44px] min-h-[44px] sm:min-w-0 sm:min-h-0 sm:p-1 -m-1 sm:m-0 rounded-lg text-gray-500 hover:text-rose-300 transition-colors focus:outline-hidden focus:ring-2 focus:ring-port-accent'
        : 'mt-1 inline-flex items-center justify-center gap-1 min-h-[44px] sm:min-h-0 sm:py-0.5 text-xs text-gray-500 hover:text-port-accent transition-colors rounded focus:outline-hidden focus:ring-2 focus:ring-port-accent'}
    >
      <BookOpen size={compact ? 14 : 12} />
      {!compact && 'How it works'}
    </button>
  );
}

// =============================================================================
// WORKED N-BACK EXAMPLE — an animated replay of a short stream
// =============================================================================
// "Press Match when the letter matches the one N back" is the sentence
// first-timers misread: the stream is transient, so the thing being compared is
// never on screen next to the thing you compare it to. Static text can't fix
// that. This plays the example the way the drill actually runs — one letter at
// a time on a stage, the sliding N-back window marked as it moves, and the
// Match press fired at the exact frame it belongs on — so the timing is SHOWN
// rather than asserted.
//
// The strip keeps every chip's BOX on every frame so the row never reflows, but
// a letter's glyph and the two moving markers appear with the frame they belong
// to. A screen reader gets the rule from the prose paragraph at the bottom, not
// from the strip.

const DEMO_PREROLL_MS = 900; // "Get ready…" before the first letter
const DEMO_STEP_MS = 1150; // one non-match letter — brisk, but readable
const DEMO_HIT_HOLD_MS = 3300; // linger on the match, then loop
// Passes before the demo parks itself on the hit frame. Looping matters — a
// reader who looked away has to be able to catch the press — but an open help
// card would otherwise animate for as long as it is mounted, and by the third
// pass the rule has landed. The Play control is the way back.
const DEMO_MAX_LOOPS = 3;

/**
 * How long frame `step` stays on screen. Exported so the suite can drive the
 * demo on the component's own schedule instead of re-declaring its constants —
 * retuning the pacing then can't leave the tests green against a timeline the
 * component no longer runs.
 */
export function demoFrameDelay(step, matchIndex) {
  if (step < 0) return DEMO_PREROLL_MS;
  return step === matchIndex ? DEMO_HIT_HOLD_MS : DEMO_STEP_MS;
}

/**
 * The caption under the stage: what a player should be thinking on this frame.
 * Pure, and exported so the phrasing is testable without driving timers — the
 * three cases (warm-up, non-match, hit) are the whole lesson.
 */
export function nBackDemoCaption({ sequence, n, step }) {
  if (step < 0) return 'Watch — the stream is about to start.';
  const letter = sequence[step];
  if (step < n) {
    return `${letter} — nothing is ${n} back yet, so there's nothing to answer.`;
  }
  const back = sequence[step - n];
  return letter === back
    ? `${letter} is the same as the ${back} ${n} back — press Match now.`
    : `${letter} vs ${back} ${n} back — different, so do nothing.`;
}

// Chip tones, keyed by what the frame is saying about that letter. A map rather
// than a ternary chain so the four looks can be read against each other.
const CHIP_TONE = {
  lit: 'border-rose-500/60 bg-rose-500/15 text-rose-300',
  current: 'border-white/60 text-white',
  compare: 'border-rose-500/40 text-rose-300/80',
  idle: 'border-port-border text-gray-400',
};

function NBackDemo({ example: { sequence, n } }) {
  const reduced = usePrefersReducedMotion();
  const matchIndex = sequence.length - 1;
  const stepLabel = pluralize(n, 'step');

  // `reduced` is policy, not state: read it at render and the "park on the last
  // frame, paused" rule lives in these two lines instead of being re-asserted by
  // initializers plus a sync effect that has to catch the setting flipping
  // mid-read. The finished frame is the one that explains the rule, so a user
  // who asked for stillness loses nothing.
  const [rawStep, setStep] = useState(-1);
  const [wantsPlay, setWantsPlay] = useState(true);
  // A backgrounded tab is the other reason to stop scheduling: PortOS is
  // routinely left open on a second tailnet machine, and an unseen animation
  // would otherwise re-render this subtree about once a second forever.
  const [hidden, setHidden] = useState(false);
  useVisibilityEvent(state => setHidden(state === 'hidden'));

  const step = reduced ? matchIndex : rawStep;
  const playing = !reduced && wantsPlay;
  const loopsRef = useRef(0);

  // One timer per frame: each render schedules only the NEXT step, so pausing,
  // hiding the tab and unmounting all reduce to "don't schedule another one".
  useEffect(() => {
    if (!playing || hidden) return undefined;
    const timer = setTimeout(() => {
      if (step < matchIndex) { setStep(step + 1); return; }
      loopsRef.current += 1;
      if (loopsRef.current >= DEMO_MAX_LOOPS) { setWantsPlay(false); return; }
      setStep(-1);
    }, demoFrameDelay(step, matchIndex));
    return () => clearTimeout(timer);
  }, [playing, hidden, step, matchIndex]);

  const hit = step === matchIndex;
  // Parked on the hit frame with nothing left to play — the control replays
  // from the top rather than resuming a stream that has already ended.
  const finished = !playing && step === matchIndex;
  const togglePlay = () => {
    if (finished) { loopsRef.current = 0; setStep(-1); }
    setWantsPlay(play => !play);
  };

  // Which chip the N-back window is pointing at right now. Before the window has
  // anything to point at (pre-roll, and the first `n` letters) it rests on the
  // position the example's one match will come from, so the marker is always
  // mounted exactly once — the strip reads correctly paused at any frame.
  const compareIndex = (step >= n ? step : matchIndex) - n;

  return (
    <div className="rounded-lg border border-port-border bg-port-bg/40 p-4 space-y-3">
      <div className="flex items-center gap-2">
        <div className="text-[0.65rem] uppercase tracking-wide text-gray-500">Example — {n}-back</div>
        {!reduced && (
          <button
            type="button"
            onClick={togglePlay}
            aria-label={playing ? 'Pause example' : finished ? 'Replay example' : 'Play example'}
            className="ml-auto inline-flex items-center gap-1 min-h-[44px] sm:min-h-0 sm:py-0.5 px-2 -my-2 sm:my-0 rounded text-[0.65rem] uppercase tracking-wide text-gray-500 hover:text-rose-300 transition-colors focus:outline-hidden focus:ring-2 focus:ring-port-accent"
          >
            {playing ? <Pause size={12} /> : <Play size={12} />}
            {playing ? 'Pause' : finished ? 'Replay' : 'Play'}
          </button>
        )}
      </div>

      {/* The stage: the drill shows ONE letter at a time and nothing else, so
          the example has to as well — a strip alone would teach the wrong task. */}
      <div
        className={`rounded-md border transition-colors ${hit ? 'border-rose-500/60 bg-rose-500/10' : 'border-port-border/60 bg-port-bg/60'}`}
      >
        <div className="h-16 flex items-center justify-center">
          <span
            data-testid="nback-demo-stage"
            aria-hidden="true"
            className={`transition-colors ${
              step < 0
                ? 'text-base text-gray-600'
                : `font-mono text-4xl font-bold ${hit ? 'text-rose-300' : 'text-white'}`
            }`}
          >
            {step < 0 ? 'Get ready…' : sequence[step]}
          </span>
        </div>
        {/* A mock of the drill's Match button, not a real control: it must never
            be reachable by tab or by name — the preview asserts no "Match"
            button exists outside a live run. It lights on the hit frame, which
            is the "when do I press?" answer the copy alone can't give. */}
        <div
          data-testid="nback-demo-press"
          aria-hidden="true"
          className={`m-3 mt-0 rounded border py-1.5 text-center text-xs font-semibold transition-[transform,color,background-color,border-color] ${
            hit
              ? 'border-rose-400 bg-rose-500/30 text-rose-100 scale-[1.03]'
              : 'border-port-border/60 text-gray-600'
          }`}
        >
          {hit ? 'Match — pressed!' : 'Match'}
        </div>
      </div>

      {/* The stream so far. The row NEVER wraps: it is `n + 3` letters long,
          and wrapping a high lag on a narrow phone puts the match and the
          letter it matches on separate lines — breaking the one relationship
          the strip exists to show. Chips shrink to fit instead, capped at their
          natural size, and each marker is positioned out of flow (the list's
          vertical padding reserves its space) because a marker is several times
          wider than the letter it points at and would otherwise stretch its own
          chip. */}
      <ol
        aria-label="Example letter stream"
        className="flex flex-nowrap justify-center gap-1.5 sm:gap-2 py-4 list-none"
      >
        {sequence.map((letter, i) => {
          const isMatch = i === matchIndex;
          const seen = i <= step;
          const isCurrent = i === step;
          // The window marker only lights once it has actually slid onto a
          // letter the demo has shown; the final hit lights both ends at once.
          const compareLit = i === compareIndex && step >= n;
          const tone = (isCurrent || compareLit) && hit ? 'lit'
            : isCurrent ? 'current'
              : compareLit ? 'compare' : 'idle';
          const marker = isMatch ? 'Match!' : i === compareIndex ? `${stepLabel} back` : null;
          const markerShown = isMatch ? hit : compareLit;
          return (
            <li key={i} className="relative flex-1 min-w-0 max-w-9 sm:max-w-10 aspect-square">
              <span
                className={`absolute inset-0 rounded-md border font-mono text-lg sm:text-xl font-bold flex items-center justify-center transition-[color,background-color,border-color,opacity] ${CHIP_TONE[tone]} ${seen ? 'opacity-100' : 'opacity-25'}`}
              >
                {/* Letters not yet shown keep their box (stable layout, no
                    reflow jitter) but hide the glyph — the box is the beat. */}
                <span className={seen ? '' : 'invisible'}>{letter}</span>
              </span>
              {marker && (
                // The window marker rides ABOVE the stream and the verdict below
                // it. Both are wider than the chip they point at, so on a 1-back
                // — where they land on adjacent chips — sharing one side runs
                // them together.
                <span
                  className={`absolute left-1/2 -translate-x-1/2 whitespace-nowrap text-[0.6rem] transition-opacity ${
                    isMatch ? 'top-full mt-1 text-rose-300' : 'bottom-full mb-1 text-gray-500'
                  } ${markerShown ? 'opacity-100' : 'opacity-0'}`}
                >
                  {marker}
                </span>
              )}
            </li>
          );
        })}
      </ol>

      <p className={`text-xs min-h-[2rem] ${hit ? 'text-rose-300' : 'text-gray-400'}`}>
        {nBackDemoCaption({ sequence, n, step })}
      </p>

      {/* The same rule in prose. The animation and its running caption are the
          explanation for anyone who can see it, so this is `sr-only` while the
          demo plays and visible when it doesn't — the card sits above a "Start
          drill" button that has to stay above the fold on a phone, and saying
          the rule twice on screen is what would push it under. */}
      <p className={reduced ? 'text-xs text-gray-500' : 'sr-only'}>
        The last <span className="font-mono text-rose-300">{sequence[matchIndex]}</span> repeats the letter {stepLabel}{' '}
        earlier — press <span className="text-white font-medium">Match</span> on it. Every other letter is a
        non-match: do nothing.
      </p>
    </div>
  );
}
