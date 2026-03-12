import { useState, useEffect } from 'react';
import { Loader } from 'lucide-react';
import { getPostConfig, getPostSessions } from '../../../services/api';
import { usePostSession } from '../../../hooks/usePostSession';
import PostSessionLauncher from '../post/PostSessionLauncher';
import PostDrillRunner from '../post/PostDrillRunner';
import PostLlmDrillRunner from '../post/PostLlmDrillRunner';
import PostSessionResults from '../post/PostSessionResults';
import PostHistory from '../post/PostHistory';
import PostDrillConfig from '../post/PostDrillConfig';
import MemoryBuilder from '../post/MemoryBuilder';
import DrillTransition from '../post/DrillTransition';
import { LLM_DRILL_TYPES } from '../post/constants';

export default function PostTab() {
  const [view, setView] = useState('launcher');
  const [config, setConfig] = useState(null);
  const [recentSessions, setRecentSessions] = useState([]);
  const [sessionTags, setSessionTags] = useState({});
  const session = usePostSession();

  useEffect(() => {
    loadData();
  }, []);

  async function loadData() {
    const [cfg, sessions] = await Promise.all([
      getPostConfig().catch(() => null),
      getPostSessions().catch(() => [])
    ]);
    setConfig(cfg);
    setRecentSessions(sessions || []);
  }

  async function handleStart(drillConfigs, tags, training = false) {
    setSessionTags(tags || {});
    const started = await session.startSession(drillConfigs, training);
    if (started) setView('running');
  }

  function handleDrillComplete() {
    setView('results');
  }

  async function handleSaved() {
    await loadData();
    setView('launcher');
    session.reset();
  }

  function handleViewHistory() {
    setView('history');
  }

  function handleViewConfig() {
    setView('config');
  }

  function handleViewMemory() {
    setView('memory');
  }

  function handleConfigSaved(newConfig) {
    setConfig(newConfig);
    setView('launcher');
  }

  function handleBack() {
    if (session.state === 'idle' || session.state === 'saved') {
      setView('launcher');
    }
  }

  // When session completes (all drills done), transition to results
  useEffect(() => {
    if (session.state === 'complete' && view === 'running') {
      setView('results');
    }
  }, [session.state, view]);

  // When between drills, show transition (handled in switch/case below)

  // Use queued drill config type (always current) rather than currentDrill (stale during loading transitions)
  const currentDrillConfig = session.drills[session.currentDrillIndex];
  const isLlmDrill = currentDrillConfig
    ? LLM_DRILL_TYPES.includes(currentDrillConfig.type)
    : session.currentDrill && LLM_DRILL_TYPES.includes(session.currentDrill.type);

  // Show transition between drills
  if (session.state === 'between-drills' && view === 'running') {
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

  switch (view) {
    case 'running':
      if (session.state === 'loading' && isLlmDrill) {
        return (
          <div className="flex flex-col items-center justify-center h-64 gap-3">
            <Loader size={32} className="text-purple-400 animate-spin" />
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
      return (
        <PostDrillRunner
          session={session}
        />
      );
    case 'results':
      return (
        <PostSessionResults
          session={session}
          tags={sessionTags}
          onSaved={handleSaved}
          onBack={handleBack}
        />
      );
    case 'history':
      return (
        <PostHistory
          onBack={() => setView('launcher')}
        />
      );
    case 'config':
      return (
        <PostDrillConfig
          config={config}
          onSaved={handleConfigSaved}
          onBack={() => setView('launcher')}
        />
      );
    case 'memory':
      return (
        <MemoryBuilder
          onBack={() => setView('launcher')}
        />
      );
    default:
      return (
        <PostSessionLauncher
          config={config}
          recentSessions={recentSessions}
          onStart={handleStart}
          onViewHistory={handleViewHistory}
          onViewConfig={handleViewConfig}
          onViewMemory={handleViewMemory}
        />
      );
  }
}
