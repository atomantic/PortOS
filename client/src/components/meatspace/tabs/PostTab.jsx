import { useState, useEffect } from 'react';
import { useNavigate, useLocation } from 'react-router';
import { Loader } from 'lucide-react';
import { getPostConfig, getPostRecommendations, getPostSessions, getPostStats } from '../../../services/api';
import { usePostSession } from '../../../hooks/usePostSession';
import toast from '../../ui/Toast';
import PostSessionLauncher from '../post/PostSessionLauncher';
import PostDrillRunner from '../post/PostDrillRunner';
import PostLlmDrillRunner from '../post/PostLlmDrillRunner';
import PostCognitiveDrillRunner from '../post/PostCognitiveDrillRunner';
import PostSessionResults from '../post/PostSessionResults';
import PostSessionDetail from '../post/PostSessionDetail';
import PostHistory from '../post/PostHistory';
import PostProgress from '../post/PostProgress';
import PostDrillConfig from '../post/PostDrillConfig';
import PracticePlan from '../post/PracticePlan';
import MemoryBuilder from '../post/MemoryBuilder';
import MemoryPractice, { MEMORY_PRACTICE_MODE_IDS } from '../post/MemoryPractice';
import ElementsSong, { ELEMENTS_MODE_IDS } from '../post/ElementsSong';
import DrillTransition from '../post/DrillTransition';
import WordplayTrainer from '../post/WordplayTrainer';
import MorseTrainer, { MORSE_MODE_IDS } from '../post/MorseTrainer';
import RhetoricTrainer from '../post/RhetoricTrainer';
import { LLM_DRILL_TYPES, COGNITIVE_DRILL_TYPES } from '../post/constants';

// The live in-progress run lives at /post/session/run; every OTHER `:subtab`
// under the `session` tab is a saved session id served at /post/session/:id.
// (The `session` tab is intentionally NOT a nav-manifest destination: the run
// is transient and the results view is a param route — both are reached via the
// launcher and History, mirroring how other `:id` detail routes aren't
// individually registered.)
const RUN_SUBROUTE = 'run';
const isRunSubroute = (subtab) => subtab === RUN_SUBROUTE;

// RESERVED memory sub-routes (`/post/memory/:subtab`) — segments that name a
// dedicated study surface rather than a memory item id. `elements` is the only
// one today; kept as a const so the guard below and the nav-manifest contract
// test (server/lib/navManifest.test.js) share one source of truth. Any OTHER
// `:subtab` is a memory ITEM id, mirroring how the session tab reserves `run`
// and treats every other subtab as a saved session id (issue #3249).
export const MEMORY_SUBROUTES = [
  { id: 'elements', label: 'Elements' },
];
const MEMORY_SUBROUTE_IDS = MEMORY_SUBROUTES.map((s) => s.id);

// A recommendation's deepLink may carry its own query string / hash; only the
// PATH decides whether it points at a different surface than the one in view.
const deepLinkPath = (deepLink) => String(deepLink || '').split(/[?#]/)[0];

// Query param carrying the restart nonce (see `restartInPlace` below).
const RUN_PARAM = 'run';

export default function PostTab({ tab = 'launcher', subtab, mode }) {
  const navigate = useNavigate();
  const location = useLocation();
  const [config, setConfig] = useState(null);
  const [recentSessions, setRecentSessions] = useState([]);
  const [stats, setStats] = useState(null);
  const [statsWeek, setStatsWeek] = useState(null);
  const session = usePostSession();
  // Seed items handed to the routed practice surfaces so a click from the list
  // skips the refetch. The URL is still the source of truth — a seed is only
  // used when its id matches the route, and a cold deep link has none.
  const [elementsItem, setElementsItem] = useState(null);
  const [memoryItem, setMemoryItem] = useState(null);

  useEffect(() => { loadData(); }, []);

  // A live/restored run is the source of truth for /post/session/run; if we land
  // there with nothing to run (direct nav, or after reset), bounce to launcher.
  useEffect(() => {
    if (tab === 'session' && isRunSubroute(subtab) && session.state === 'idle') {
      navigate('/post/launcher', { replace: true });
    }
  }, [tab, subtab, session.state, navigate]);

  async function loadData() {
    const [cfg, sessions, st, stWeek] = await Promise.all([
      getPostConfig().catch(() => null),
      getPostSessions().catch(() => []),
      getPostStats(30).catch(() => null),
      getPostStats(7).catch(() => null)
    ]);
    setConfig(cfg);
    setRecentSessions(sessions || []);
    setStats(st);
    setStatsWeek(stWeek);
  }

  async function handleStart(drillConfigs, conditions, training = false, sessionPlan = null, benchmark = null) {
    const started = await session.startSession(drillConfigs, training, conditions || {}, sessionPlan, benchmark);
    if (started) navigate('/post/session/run');
  }

  // The top recommendation deep-links to the page already in view — which a
  // sub-50% run legitimately produces, since the drill just missed is the very
  // item the scheduler resurfaces first. `navigate()` to the current URL is a
  // no-op, so bump a `run` nonce instead: it flows into each practice surface's
  // key below and remounts the drill for a fresh run. Unrelated params survive
  // (Morse threads its `?ref=` reference tab through the URL).
  function restartInPlace() {
    const params = new URLSearchParams(location.search);
    const current = Number(params.get(RUN_PARAM));
    params.set(RUN_PARAM, String(Number.isFinite(current) ? current + 1 : 1));
    navigate(`${location.pathname}?${params}`);
  }

  // Find and route to the next unpracticed item in the daily routine.
  async function continueDailyRoutine() {
    const result = await getPostRecommendations(1).catch(() => null);
    const recommendation = result?.recommendations?.[0];
    // The server sinks anything already practiced today to the bottom, so a top
    // rec still flagged means nothing NEW is left in the rotation — end at the
    // launcher rather than handing back the drill just finished (issue #3563).
    if (!recommendation || recommendation.practicedToday) {
      if (recommendation) toast.success("That's everything in today's routine — nice work");
      navigate('/post/launcher');
      return;
    }
    const target = deepLinkPath(recommendation.deepLink);
    if (target && target !== '/post/launcher') {
      if (target === location.pathname) restartInPlace();
      else navigate(recommendation.deepLink);
      return;
    }
    navigate(`/post/launcher?continue=${encodeURIComponent(recommendation.id)}`);
  }

  // Save success either continues the daily recommendation chain or opens a
  // deep-linkable SCORED result. Training runs have durable ids too, but the
  // scored-session detail endpoint deliberately excludes them, so they return
  // to the launcher instead of navigating to a guaranteed not-found route.
  async function handleSaved(savedSession, { continueDaily = false } = {}) {
    await loadData();
    session.reset();
    if (continueDaily) await continueDailyRoutine();
    else if (savedSession?.id && !savedSession.training) navigate(`/post/session/${savedSession.id}`);
    else navigate('/post/launcher');
  }

  function handleConfigSaved(newConfig) {
    setConfig(newConfig);
    navigate('/post/launcher');
  }

  function handleBack() {
    if (session.state === 'idle' || session.state === 'saved') {
      session.reset();
      navigate('/post/launcher');
    }
  }

  // Restart nonce set by `restartInPlace`. Folded into the key of every surface
  // `continueDailyRoutine` can target, so a same-page "continue" remounts the
  // drill instead of leaving its completion screen on screen.
  const runNonce = new URLSearchParams(location.search).get(RUN_PARAM) || '';

  const currentDrillConfig = session.drills[session.currentDrillIndex];
  const activeType = currentDrillConfig?.type || session.currentDrill?.type;
  const isLlmDrill = activeType ? LLM_DRILL_TYPES.includes(activeType) : false;
  const isCognitiveDrill = activeType ? COGNITIVE_DRILL_TYPES.includes(activeType) : false;

  // Active run / saved-session results live at their own URLs: /post/session/run
  // (the live run) and /post/session/:id (any saved session — shareable).
  // Handled before the tab `switch` so `session` isn't a nav-manifest tab.
  if (tab === 'session') {
    if (!isRunSubroute(subtab)) {
      // Any non-`run` subtab is a saved session id.
      return <PostSessionDetail id={subtab} onBack={() => navigate('/post/history')} />;
    }
    // Completed but not yet saved → live results screen with the Save button.
    if (session.state === 'complete' || session.state === 'saving') {
      return (
        <PostSessionResults
          session={session}
          conditions={{}}
          onSaved={handleSaved}
          onBack={handleBack}
        />
      );
    }

    if (session.state === 'between-drills') {
      const nextIndex = session.currentDrillIndex + 1;
      const nextDrill = session.drills[nextIndex];
      if (nextDrill) {
        return (
          <DrillTransition
            nextDrillType={nextDrill.type}
            drillIndex={nextIndex}
            drillCount={session.drillCount}
            completedResults={session.drillResults}
            onContinue={session.nextDrill}
          />
        );
      }
    }

    if (session.state === 'loading' && (isLlmDrill || isCognitiveDrill)) {
      return (
        <div className="flex flex-col items-center justify-center h-64 gap-3">
          <Loader size={32} className="text-port-accent-2 animate-spin" />
          <div className="text-gray-400">Processing {currentDrillConfig?.type ? currentDrillConfig.type.replace(/-/g, ' ') : 'drill'}...</div>
        </div>
      );
    }
    if (session.currentDrill && isLlmDrill) {
      return (
        <PostLlmDrillRunner
          drill={session.currentDrill}
          timeLimitSec={session.currentDrill.timeLimitSec}
          drillIndex={session.currentDrillIndex}
          drillCount={session.drillCount}
          onComplete={session.completeLlmDrill}
          isTraining={session.isTraining}
          providerId={currentDrillConfig?.providerId}
          model={currentDrillConfig?.model}
        />
      );
    }
    if (session.currentDrill && isCognitiveDrill) {
      return (
        <PostCognitiveDrillRunner
          drill={session.currentDrill}
          drillIndex={session.currentDrillIndex}
          drillCount={session.drillCount}
          onComplete={session.completeCognitiveDrill}
          isTraining={session.isTraining}
        />
      );
    }
    if (session.currentDrill) return <PostDrillRunner session={session} />;

    // idle/saved (or a stale loading with no drill): the redirect effect above
    // sends us to the launcher; render a spinner in the meantime.
    return (
      <div className="flex flex-col items-center justify-center h-64 gap-3">
        <Loader size={32} className="text-port-accent animate-spin" />
      </div>
    );
  }

  switch (tab) {
    case 'history':
      return <PostHistory onBack={() => navigate('/post/launcher')} />;
    case 'progress':
      return <PostProgress subtab={subtab} onBack={() => navigate('/post/launcher')} />;
    case 'config':
      // Wait for the async config load before mounting the editor: its state is
      // seeded once from the `config` prop, so mounting on a null/loading config
      // would seed drill defaults and a subsequent Save would overwrite the
      // user's saved settings. Mirrors PostSessionLauncher's null guard.
      return config ? (
        <PostDrillConfig
          config={config}
          onSaved={handleConfigSaved}
          onBack={() => navigate('/post/launcher')}
        />
      ) : (
        <div className="text-gray-500">Loading configuration...</div>
      );
    case 'plan':
      // Practice Plan owns "what am I studying" (issue #3252). Same null guard
      // as `config`: the editor seeds its draft state once from the loaded
      // config, so mounting before it resolves would save defaults over the
      // user's settings.
      return config ? (
        <PracticePlan
          config={config}
          onSaved={handleConfigSaved}
          onBack={() => navigate('/post/launcher')}
        />
      ) : (
        <div className="text-gray-500">Loading practice plan...</div>
      );
    case 'wordplay':
      // Selected game mode is the `:mode` sub-route (URL is source of truth),
      // mirroring the Morse trainer's `:mode` routing.
      return (
        <WordplayTrainer
          key={`run:${runNonce}`}
          config={config}
          onConfigUpdate={setConfig}
          mode={subtab}
          onSelectMode={(id) => navigate(`/post/wordplay/${id}`)}
          onExitMode={() => navigate('/post/wordplay')}
          onBack={() => navigate('/post/launcher')}
          onContinue={continueDailyRoutine}
        />
      );
    case 'rhetoric':
      return (
        <RhetoricTrainer
          mode={subtab}
          onSelectMode={(id) => navigate(`/post/rhetoric/${id}`)}
          onExitMode={() => navigate('/post/rhetoric')}
          onBack={() => navigate('/post/launcher')}
          onContinue={continueDailyRoutine}
        />
      );
    case 'morse': {
      // The `:mode` sub-route (copy/send) is the source of truth; an unknown
      // segment degrades to the mode grid instead of a blank panel.
      const morseMode = MORSE_MODE_IDS.includes(subtab) ? subtab : null;
      // Preserve the current `?ref=` search param across mode transitions so the
      // selected reference tab (tree/length/list) survives entering/exiting a
      // mode — both mode and reference view are deep-linkable, so switching one
      // must not silently reset the other back to its default.
      return (
        <MorseTrainer
          key={`run:${runNonce}`}
          mode={morseMode}
          onSelectMode={(id) => navigate(`/post/morse/${id}${location.search}`)}
          onExitMode={() => navigate(`/post/morse${location.search}`)}
          onBack={() => navigate('/post/launcher')}
          onContinue={continueDailyRoutine}
        />
      );
    }
    case 'memory': {
      // `/post/memory` → the item list. Any other `:subtab` selects an item:
      // `elements` is the reserved Elements Song surface, everything else is a
      // memory item id. The optional third segment is the practice mode, so a
      // drill is directly linkable (issue #3249). An unrecognized mode degrades
      // to the mode picker, mirroring MorseTrainer's MORSE_MODE_IDS guard.
      if (!subtab) {
        return (
          <MemoryBuilder
            onBack={() => navigate('/post/launcher')}
            onSelectItem={(item) => {
              if (item.id === 'elements-song') { setElementsItem(item); navigate('/post/memory/elements'); }
              else { setMemoryItem(item); navigate(`/post/memory/${item.id}`); }
            }}
            onReviewItem={(item) => {
              if (item.id === 'elements-song') navigate('/post/memory/elements/element-flash');
              else navigate(`/post/memory/${item.id}/spaced`);
            }}
          />
        );
      }
      if (MEMORY_SUBROUTE_IDS.includes(subtab)) {
        const elementsMode = ELEMENTS_MODE_IDS.includes(mode) ? mode : null;
        return (
          <ElementsSong
            key={`run:${runNonce}`}
            item={elementsItem}
            mode={elementsMode}
            onSelectMode={(id) => navigate(`/post/memory/elements/${id}`)}
            onExitMode={() => navigate('/post/memory/elements')}
            onBack={() => { setElementsItem(null); navigate('/post/memory'); }}
            onContinue={continueDailyRoutine}
            loadItemOnMount={!elementsItem}
          />
        );
      }
      const practiceMode = MEMORY_PRACTICE_MODE_IDS.includes(mode) ? mode : null;
      // Only pass the cached item when it actually matches the URL — a stale
      // one from a previous selection would render the wrong item's practice.
      // Keying on the mode remounts the runner per entry, so each run starts
      // from clean state without a manual reset.
      return (
        <MemoryPractice
          key={`${subtab}:${practiceMode || 'picker'}:${runNonce}`}
          itemId={subtab}
          item={memoryItem?.id === subtab ? memoryItem : null}
          mode={practiceMode}
          onSelectMode={(id) => navigate(`/post/memory/${subtab}/${id}`)}
          onExitMode={() => navigate(`/post/memory/${subtab}`)}
          onBack={() => { setMemoryItem(null); navigate('/post/memory'); }}
          onContinue={continueDailyRoutine}
        />
      );
    }
    default:
      return (
        <PostSessionLauncher
          config={config}
          recentSessions={recentSessions}
          stats={stats}
          statsWeek={statsWeek}
          onStart={handleStart}
          onViewHistory={() => navigate('/post/history')}
          onViewConfig={() => navigate('/post/config')}
          onViewMemory={() => navigate('/post/memory')}
          onViewMorse={() => navigate('/post/morse')}
          autoStartRecommendationId={new URLSearchParams(location.search).get('continue')}
          onAutoStartConsumed={() => navigate('/post/launcher', { replace: true })}
          onNavigate={navigate}
        />
      );
  }
}
