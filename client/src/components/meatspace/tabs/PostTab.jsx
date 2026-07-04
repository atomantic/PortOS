import { useState, useEffect } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { Loader } from 'lucide-react';
import { getPostConfig, getPostSessions, getPostStats } from '../../../services/api';
import { usePostSession } from '../../../hooks/usePostSession';
import PostSessionLauncher from '../post/PostSessionLauncher';
import PostDrillRunner from '../post/PostDrillRunner';
import PostLlmDrillRunner from '../post/PostLlmDrillRunner';
import PostCognitiveDrillRunner from '../post/PostCognitiveDrillRunner';
import PostSessionResults from '../post/PostSessionResults';
import PostSessionDetail from '../post/PostSessionDetail';
import PostHistory from '../post/PostHistory';
import PostProgress from '../post/PostProgress';
import PostDrillConfig from '../post/PostDrillConfig';
import MemoryBuilder from '../post/MemoryBuilder';
import ElementsSong from '../post/ElementsSong';
import DrillTransition from '../post/DrillTransition';
import WordplayTrainer from '../post/WordplayTrainer';
import MorseTrainer, { MORSE_MODE_IDS } from '../post/MorseTrainer';
import { LLM_DRILL_TYPES, COGNITIVE_DRILL_TYPES } from '../post/constants';

// The live in-progress run lives at /post/session/run; every OTHER `:subtab`
// under the `session` tab is a saved session id served at /post/session/:id.
// (The `session` tab is intentionally NOT a nav-manifest destination: the run
// is transient and the results view is a param route — both are reached via the
// launcher and History, mirroring how other `:id` detail routes aren't
// individually registered.)
const RUN_SUBROUTE = 'run';
const isRunSubroute = (subtab) => subtab === RUN_SUBROUTE;

export default function PostTab({ tab = 'launcher', subtab }) {
  const navigate = useNavigate();
  const location = useLocation();
  const [config, setConfig] = useState(null);
  const [recentSessions, setRecentSessions] = useState([]);
  const [stats, setStats] = useState(null);
  const [statsWeek, setStatsWeek] = useState(null);
  const session = usePostSession();
  const [elementsItem, setElementsItem] = useState(null);

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

  async function handleStart(drillConfigs, tags, training = false) {
    const started = await session.startSession(drillConfigs, training, tags || {});
    if (started) navigate('/post/session/run');
  }

  // Save success → jump to the deep-linkable results URL for this session, so it
  // is shareable/bookmarkable/reachable from History. The run id === session id.
  async function handleSaved(savedSession) {
    await loadData();
    session.reset();
    if (savedSession?.id) navigate(`/post/session/${savedSession.id}`);
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
          tags={{}}
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
    case 'wordplay':
      // Selected game mode is the `:mode` sub-route (URL is source of truth),
      // mirroring the Morse trainer's `:mode` routing.
      return (
        <WordplayTrainer
          config={config}
          onConfigUpdate={setConfig}
          mode={subtab}
          onSelectMode={(id) => navigate(`/post/wordplay/${id}`)}
          onExitMode={() => navigate('/post/wordplay')}
          onBack={() => navigate('/post/launcher')}
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
          mode={morseMode}
          onSelectMode={(id) => navigate(`/post/morse/${id}${location.search}`)}
          onExitMode={() => navigate(`/post/morse${location.search}`)}
          onBack={() => navigate('/post/launcher')}
        />
      );
    }
    case 'memory':
      if (subtab === 'elements') {
        return (
          <ElementsSong
            item={elementsItem}
            onBack={() => { setElementsItem(null); navigate('/post/memory'); }}
            loadItemOnMount={!elementsItem}
          />
        );
      }
      return (
        <MemoryBuilder
          onBack={() => navigate('/post/launcher')}
          onNavigateElements={(item) => { setElementsItem(item); navigate('/post/memory/elements'); }}
        />
      );
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
        />
      );
  }
}
