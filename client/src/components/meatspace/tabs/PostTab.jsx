import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
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
import ElementsSong from '../post/ElementsSong';
import DrillTransition from '../post/DrillTransition';
import WordplayTrainer from '../post/WordplayTrainer';
import MorseTrainer from '../post/MorseTrainer';
import { LLM_DRILL_TYPES } from '../post/constants';

export default function PostTab({ tab = 'launcher', subtab }) {
  const navigate = useNavigate();
  const [config, setConfig] = useState(null);
  const [recentSessions, setRecentSessions] = useState([]);
  const [sessionTags, setSessionTags] = useState({});
  const [sessionView, setSessionView] = useState(null);
  const session = usePostSession();
  const [elementsItem, setElementsItem] = useState(null);

  useEffect(() => { loadData(); }, []);

  useEffect(() => {
    if (tab !== 'launcher' || subtab) setSessionView(null);
  }, [tab, subtab]);

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
      return (
        <PostDrillConfig
          config={config}
          onSaved={handleConfigSaved}
          onBack={() => navigate('/post/launcher')}
        />
      );
    case 'wordplay':
      return <WordplayTrainer config={config} onBack={() => navigate('/post/launcher')} />;
    case 'morse':
      return <MorseTrainer onBack={() => navigate('/post/launcher')} />;
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
          onStart={handleStart}
          onViewHistory={() => navigate('/post/history')}
          onViewConfig={() => navigate('/post/config')}
          onViewMemory={() => navigate('/post/memory')}
          onViewMorse={() => navigate('/post/morse')}
        />
      );
  }
}
