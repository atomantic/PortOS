import { forceCosEvaluate, forceHealthCheck, pauseCos, resumeCos, startCos, stopCos, updateCosConfig } from '../../services/apiAgents.js';
import toast from '../ui/Toast';
import { summarizeHealthIssues } from './constants';

export default function useCosDaemonActions({ avatar, fetchData, applyStatus, applyHealth, markHealthUnavailable, healthObservationRef }) {
  const { currentAgentState, setAgentState, setStatusMessage, setSpeakingFor } = avatar;

  // Update avatar style via server config
  const setAvatarStyle = async (style) => {
    await updateCosConfig({ avatarStyle: style });
    fetchData();
  };

  const handleStart = async () => {
    const result = await startCos({ silent: true }).catch(err => {
      toast.error(err.message);
      return null;
    });
    if (result?.success) {
      toast.success('Chief of Staff started');
      setAgentState('thinking');
      setStatusMessage("Starting daemon - scanning for tasks...");
      setSpeakingFor();
      fetchData();
    }
  };

  const handleStop = async () => {
    const result = await stopCos({ silent: true }).catch(err => {
      toast.error(err.message);
      return null;
    });
    if (result?.success) {
      toast.success('Chief of Staff stopped');
      setAgentState('sleeping');
      setStatusMessage("Stopped - daemon not running");
      fetchData();
    }
  };

  const handlePause = async () => {
    const reason = 'Paused from Chief of Staff controls';
    const result = await pauseCos(reason, { silent: true }).catch(err => {
      toast.error(err.message);
      return null;
    });
    if (result?.success) {
      toast.success('Chief of Staff paused');
      applyStatus(prev => ({ ...prev, paused: true, pausedAt: result.pausedAt, pauseReason: reason }));
      setAgentState('sleeping');
      setStatusMessage(`Paused — ${reason}`);
      fetchData();
    }
  };

  const handleResume = async () => {
    const result = await resumeCos({ silent: true }).catch(err => {
      toast.error(err.message);
      return null;
    });
    if (result?.success) {
      toast.success('Chief of Staff resumed');
      applyStatus(prev => ({ ...prev, paused: false, pausedAt: null, pauseReason: null }));
      setAgentState('thinking');
      setStatusMessage('Resuming daemon - scanning for tasks...');
      fetchData();
    }
  };

  const handleForceEvaluate = async () => {
    // Only announce success / drive the "thinking" state after the request
    // actually resolves — a failed evaluate must not flash a success toast.
    try {
      await forceCosEvaluate({ silent: true });
      toast.success('Evaluation triggered');
      setAgentState('thinking');
      setStatusMessage("Evaluating tasks...");
      setSpeakingFor();
    } catch (err) {
      toast.error(err.message);
    }
  };

  const handleHealthCheck = async () => {
    setAgentState('investigating');
    setStatusMessage("Running system health check...");
    const speakingGeneration = setSpeakingFor();
    const healthObservation = healthObservationRef.current;
    const result = await forceHealthCheck({ silent: true }).catch(err => {
      toast.error(err.message);
      return null;
    });
    setSpeakingFor(0, speakingGeneration);
    if (Array.isArray(result?.issues)) {
      const checkedHealth = applyHealth({ lastCheck: result.metrics?.timestamp, issues: result.issues }, { merge: true });
      // The Health route does not load the Tasks-only insights banner.
      toast.success('Health check complete');
      if (checkedHealth.issues.length > 0) {
        setStatusMessage(summarizeHealthIssues(checkedHealth.issues));
      } else {
        // Sleeping only when the daemon is not running; an idle running one is Thinking.
        setAgentState(currentAgentState());
        setStatusMessage("Health check passed - all systems OK");
      }
    } else {
      markHealthUnavailable(healthObservation);
      if (healthObservation === healthObservationRef.current) setStatusMessage('System health unavailable');
    }
  };

  return { setAvatarStyle, handleStart, handleStop, handlePause, handleResume, handleForceEvaluate, handleHealthCheck };
}
