import { useState, useEffect } from 'react';
import { getPostConfig, getPostSessions } from '../../../services/api';
import { usePostSession } from '../../../hooks/usePostSession';
import PostSessionLauncher from '../post/PostSessionLauncher';
import PostDrillRunner from '../post/PostDrillRunner';
import PostLlmDrillRunner from '../post/PostLlmDrillRunner';
import PostSessionResults from '../post/PostSessionResults';
import PostHistory from '../post/PostHistory';
import PostDrillConfig from '../post/PostDrillConfig';
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

  async function handleStart(drillConfigs, tags) {
    setSessionTags(tags || {});
    const started = await session.startSession(drillConfigs);
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

  // When between drills, auto-advance
  useEffect(() => {
    if (session.state === 'between-drills') {
      session.nextDrill();
    }
  }, [session.state, session.nextDrill]);

  const isLlmDrill = session.currentDrill && LLM_DRILL_TYPES.includes(session.currentDrill.type);

  switch (view) {
    case 'running':
      if (isLlmDrill) {
        return (
          <PostLlmDrillRunner
            drill={session.currentDrill}
            timeLimitSec={session.currentDrill.timeLimitSec}
            drillIndex={session.currentDrillIndex}
            drillCount={session.drillCount}
            onComplete={session.completeLlmDrill}
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
    default:
      return (
        <PostSessionLauncher
          config={config}
          recentSessions={recentSessions}
          onStart={handleStart}
          onViewHistory={handleViewHistory}
          onViewConfig={handleViewConfig}
        />
      );
  }
}
