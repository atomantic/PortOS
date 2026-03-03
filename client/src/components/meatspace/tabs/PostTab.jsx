import { useState, useEffect } from 'react';
import { getPostConfig, getPostSessions } from '../../../services/api';
import { usePostSession } from '../../../hooks/usePostSession';
import PostSessionLauncher from '../post/PostSessionLauncher';
import PostDrillRunner from '../post/PostDrillRunner';
import PostSessionResults from '../post/PostSessionResults';
import PostHistory from '../post/PostHistory';
import PostDrillConfig from '../post/PostDrillConfig';

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
      getPostConfig(),
      getPostSessions()
    ]);
    setConfig(cfg);
    setRecentSessions(sessions);
  }

  function handleStart(drillConfigs, tags) {
    setSessionTags(tags || {});
    session.startSession(drillConfigs);
    setView('running');
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
  }, [session.state]);

  switch (view) {
    case 'running':
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
