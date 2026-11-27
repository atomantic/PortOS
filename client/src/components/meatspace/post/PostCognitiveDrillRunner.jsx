import { useState } from 'react';
import { Play } from 'lucide-react';
import { noPointerFocusSurfaceProps } from '../../../lib/a11yKeyboard.js';
import DrillHeader from './drills/DrillHeader';
import NBackRunner from './drills/NBackRunner';
import DigitSpanRunner from './drills/DigitSpanRunner';
import StroopRunner from './drills/StroopRunner';
import SchulteTableRunner from './drills/SchulteTableRunner';
import MentalRotationRunner from './drills/MentalRotationRunner';
import ReactionTimeRunner from './drills/ReactionTimeRunner';
import BinaryChoiceRunner from './drills/BinaryChoiceRunner';
import GoNoGoRunner from './drills/GoNoGoRunner';
import {
  CognitiveDrillTutorial,
  getDrillTutorial,
  hasDrillTutorial,
  hasSeenDrillTutorial,
  markDrillTutorialSeen,
} from './CognitiveDrillTutorial';

export { buildNBackInkSequence, NBACK_INK_COLORS } from './drills/NBackRunner';
export {
  localAccuracyScore,
  localNBackScore,
  localReactionTimeScore,
  localSchulteMetrics,
  localTaskSwitchMetrics,
  localGoNoGoMetrics,
  localFlankerMetrics,
  buildCognitiveResult,
  buildNBackQuestions,
  scoreDigitSpanRecall,
  scoreStroopTrial,
  scoreMentalRotationTrial,
  scoreSchulteClick,
  scoreTaskSwitchTrial,
  scoreGoNoGoTrial,
  scoreFlankerTrial,
} from './cognitiveScoring';

/**
 * Runs timed cognitive drills. Each sub-runner assembles a full drill
 * result — `{ module,
 * type, config, drillData, questions, score, totalMs }` — and hands it to
 * `onComplete`. The client score is a local estimate for the immediate results
 * view. The server recomputes it deterministically from `drillData` on save
 * (server/services/meatspace/meatspacePostCognitive.js).
 */
export default function PostCognitiveDrillRunner({ drill, drillIndex, drillCount, onComplete, isTraining }) {
  if (!drill) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-gray-400">Loading drill...</div>
      </div>
    );
  }

  const shared = { drill, drillIndex, drillCount, onComplete, isTraining };
  // These drills are timed/stimulus-driven — the stimulus starts flashing the
  // instant the runner mounts, which is disorienting the first time. Gate the
  // first-ever encounter of each drill type behind a how-to card so the timers
  // (and each runner's `startedAtRef`) don't start until the user taps Start.
  // Keyed by drill.type so each new type in a session re-evaluates cleanly.
  return (
    // These drills are scored on the keydown, and native button activation fires
    // on the keyup — so a click that parked focus on a response button would
    // silently inflate every later reaction time.
    <div {...noPointerFocusSurfaceProps}>
      <DrillTutorialGate
        key={drill.type}
        drill={drill}
        isTraining={isTraining}
        drillIndex={drillIndex}
        drillCount={drillCount}
      >
        {renderCognitiveDrill(shared)}
      </DrillTutorialGate>
    </div>
  );
}

// Element factory for the actual runner. Returned as `children` to the gate but
// only mounted (so its timers only arm) once the gate renders it — building the
// element here is side-effect-free.
function renderCognitiveDrill(shared) {
  switch (shared.drill.type) {
    case 'n-back':
      return <NBackRunner {...shared} />;
    case 'digit-span':
      return <DigitSpanRunner {...shared} />;
    case 'stroop':
      return <StroopRunner {...shared} />;
    case 'schulte-table':
      return <SchulteTableRunner {...shared} />;
    case 'mental-rotation':
      return <MentalRotationRunner {...shared} />;
    case 'reaction-time':
      return <ReactionTimeRunner {...shared} />;
    case 'task-switching':
      return <BinaryChoiceRunner {...shared} type="task-switching" />;
    case 'go-no-go':
      return <GoNoGoRunner {...shared} />;
    case 'flanker':
      return <BinaryChoiceRunner {...shared} type="flanker" />;
    default:
      return <div className="text-port-error text-center py-8">Unsupported cognitive drill: {shared.drill.type}</div>;
  }
}

// Hold the runner until the first-run tutorial is dismissed. Settings and
// launcher surfaces import the tutorial directly without mounting the runner.

function DrillTutorialGate({ drill, isTraining, drillIndex, drillCount, children }) {
  const [showTutorial, setShowTutorial] = useState(
    () => hasDrillTutorial(drill.type) && !hasSeenDrillTutorial(drill.type),
  );
  if (!showTutorial) return children;
  return (
    <CognitiveDrillTutorial
      drill={drill}
      tut={getDrillTutorial(drill)}
      header={<DrillHeader type={drill.type} isTraining={isTraining} drillIndex={drillIndex} drillCount={drillCount} />}
      onAction={() => { markDrillTutorialSeen(drill.type); setShowTutorial(false); }}
      actionLabel="Start drill"
      ActionIcon={Play}
      footNote="You’ll only see this the first time for each drill type. Reopen it any time from the launcher or Config."
    />
  );
}
