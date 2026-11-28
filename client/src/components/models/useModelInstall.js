import { useEffect, useRef, useState } from 'react';
import socket from '../../services/socket';
import toast from '../ui/Toast';

export default function useModelInstall({
  scope,
  installRequest,
  cancelRequest,
  reloadStatus,
  updateStatus,
  installingMessage,
  successMessage,
  cancelFailureMessage,
}) {
  const [installing, setInstalling] = useState(false);
  const [progressMsg, setProgressMsg] = useState('');
  const [installError, setInstallError] = useState('');
  const [installingStage, setInstallingStage] = useState(null);
  const progressTimer = useRef(null);

  useEffect(() => {
    const handleProgress = (data) => {
      if (data?.scope !== scope) return;
      clearTimeout(progressTimer.current);
      if (data.stage) setInstallingStage(data.stage);
      setProgressMsg(data.message || '');
      if (data.event === 'complete') {
        setInstalling(false);
        setInstallingStage(null);
        // Keep the completion message briefly in local UI state.
        progressTimer.current = setTimeout(() => setProgressMsg(''), 3000);
        reloadStatus();
      }
      if (data.event === 'error') {
        setInstalling(false);
        setInstallError(data.message || 'Installation failed. Refresh status for diagnostics.');
        reloadStatus();
      }
    };
    socket.on('localLlm:progress', handleProgress);
    return () => {
      socket.off('localLlm:progress', handleProgress);
      clearTimeout(progressTimer.current);
    };
  }, [scope, reloadStatus]);

  const install = () => {
    clearTimeout(progressTimer.current);
    setInstallError('');
    setInstallingStage(null);
    setInstalling(true);
    setProgressMsg(installingMessage);
    return installRequest({ silent: true })
      .then((result) => {
        if (result?.ready === true) {
          toast.success(successMessage);
          if (updateStatus) return updateStatus(result);
        }
        return reloadStatus();
      })
      .catch((error) => { setInstallError(error?.message || 'Installation failed.'); return reloadStatus(); })
      .finally(() => {
        setInstalling(false);
        setInstallingStage(null);
      });
  };

  const cancel = () => cancelRequest({ silent: true })
    .then(() => reloadStatus())
    .catch((error) => toast.error(error?.message || cancelFailureMessage));

  return { installing, installingStage, progressMsg, installError, install, cancel };
}
