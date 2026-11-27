import { useCallback, useEffect, useState } from 'react';
import { getApps } from '../../services/apiApps.js';
import { createRun, stopRun } from '../../services/apiRuns.js';
import socket from '../../services/socket';
import useListResource from '../../hooks/useListResource.js';
import { useAsyncAction } from '../../hooks/useAsyncAction';
import { isTuiProvider } from '../../utils/providers';

export default function useProviderQuickRun(defaultProvider, activeProviderId) {
  const [showRunPanel, setShowRunPanel] = useState(false);
  const [runPrompt, setRunPrompt] = useState('');
  const [selectedWorkspace, setSelectedWorkspace] = useState('');
  const loadApps = useCallback(async () => {
    const list = await getApps({ silent: true });
    return Array.isArray(list) ? list : [];
  }, []);
  const appsResource = useListResource(loadApps);
  const { items: apps, state: appsState, error: appsError, retry: retryApps } = appsResource;
  const [activeRun, setActiveRun] = useState(null);
  const [runOutput, setRunOutput] = useState('');

  useEffect(() => {
    if (!activeRun) return;

    const handleData = (data) => {
      setRunOutput(prev => prev + data);
    };

    const handleComplete = (_metadata) => {
      setActiveRun(null);
    };

    socket.on(`run:${activeRun}:data`, handleData);
    socket.on(`run:${activeRun}:complete`, handleComplete);

    return () => {
      socket.off(`run:${activeRun}:data`, handleData);
      socket.off(`run:${activeRun}:complete`, handleComplete);
    };
  }, [activeRun]);

  const [handleExecuteRun, startingRun] = useAsyncAction(async () => {
    if (!runPrompt.trim() || !activeProviderId) return;

    setRunOutput('');
    const workspace = apps.find(a => a.id === selectedWorkspace);

    const result = await createRun({
      providerId: activeProviderId,
      prompt: runPrompt,
      workspacePath: workspace?.repoPath,
      workspaceName: workspace?.name,
    }, { silent: true }).catch(err => ({ error: err.message }));

    if (result.error) {
      setRunOutput(`Error: ${result.error}`);
      return;
    }

    setActiveRun(result.runId);
  });

  const handleStopRun = async () => {
    if (activeRun) {
      await stopRun(activeRun);
      setActiveRun(null);
    }
  };

  return {
    showRunPanel, setShowRunPanel, apps, appsState, appsError, retryApps, selectedWorkspace, setSelectedWorkspace,
    runPrompt, setRunPrompt, activeRun, runOutput, runProviderIsTui: isTuiProvider(defaultProvider),
    onExecuteRun: handleExecuteRun, startingRun, onStopRun: handleStopRun,
  };
}
