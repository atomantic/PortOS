import { useState, useEffect } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { Loader } from 'lucide-react';
import { getPostConfig, getPostSessions, getPostStats } from '../../../services/api';
import { usePostSession } from '../../../hooks/usePostSession';
import PostSessionLauncher from '../post/PostSessionLauncher';
import PostDrillRunner from '../post/PostDrillRunner';
import PostLlmDrillRunner from '../post/PostLlmDrillRunner';
import PostSessionResults from '../post/PostSessionResults';
import PostHistory from '../post/PostHistory';
import PostDrillConfig from '../post/PostDrillConfig';
import MemoryBuilder from '../post/MemoryBuilder';
import ElementsSong from '../post/ElementsSong';
import DrillTransition from '../post/DrillTransition';
import WordplayTrainer from '../post/WordplayTrainer';
import MorseTrainer, { MORSE_MODE_IDS } from '../post/MorseTrainer';
import { LLM_DRILL_TYPES } from '../post/constants';

export default function PostTab({ tab = 'launcher', subtab }) {
  const navigate = useNavigate();
  const location = useLocation();
  const [config, setConfig] = useState(null);
  const [recentSessions, setRecentSessions] = useState([]);
  const [stats, setStats] = useState(null);
  const [statsWeek, setStatsWeek] = useState(null);
  const [sessionTags, setSessionTags] = useState({});
  const [sessionView, setSessionView] = useState(null);
  const session = usePostSession();
  const [elementsItem, setElementsItem] = useState(null);

  useEffect(() => { loadData(); }, []);

  useEffect(() => {
    if (tab !== 'launcher' || subtab) setSessionView(null);
  }, [tab, subtab]);

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
    setSessionTags(tags || {});
    const started = await session.startSession(drillConfigs, training);
    if (started) setSessionView('running');
  }

  async function handleSaved() {
    await loadData();
    setSessionView(null);
    session.reset();
    navigate('/post/launcher');
  }

  function handleConfigSaved(newConfig) {
    setConfig(newConfig);
    navigate('/post/launcher');
  }

  function handleBack() {
    if (session.state === 'idle' || session.state === 'saved') {
      setSessionView(null);
      navigate('/post/launcher');
    }
  }

  useEffect(() => {
    if (session.state === 'complete' && sessionView === 'running') {
      setSessionView('results');
    }
  }, [session.state, sessionView]);

  const currentDrillConfig = session.drills[session.currentDrillIndex];
  const isLlmDrill = currentDrillConfig
    ? LLM_DRILL_TYPES.includes(currentDrillConfig.type)
    : session.currentDrill && LLM_DRILL_TYPES.includes(session.currentDrill.type);

  // Ephemeral session views overlay the launcher tab
  if (tab === 'launcher' && sessionView) {
    if (session.state === 'between-drills' && sessionView === 'running') {
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

    if (sessionView === 'running') {
      if (session.state === 'loading' && isLlmDrill) {
        return (
          <div className="flex flex-col items-center justify-center h-64 gap-3">
            <Loader size={32} className="text-port-accent-2 animate-spin" />
            <div className="text-gray-400">Processing {currentDrillConfig?.type ? currentDrillConfig.type.replace(/-/g, ' ') : 'drill'}...</div>
          </div>
        );
      }
      if (isLlmDrill) {
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
      return <PostDrillRunner session={session} />;
    }

    if (sessionView === 'results') {
      return (
        <PostSessionResults
          session={session}
          tags={sessionTags}
          onSaved={handleSaved}
          onBack={handleBack}
        />
      );
    }
  }

  switch (tab) {
    case 'history':
      return <PostHistory onBack={() => navigate('/post/launcher')} />;
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
      return <WordplayTrainer config={config} onConfigUpdate={setConfig} onBack={() => navigate('/post/launcher')} />;
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
