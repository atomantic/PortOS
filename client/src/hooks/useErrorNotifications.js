import { useEffect, useCallback } from 'react';
import toast from '../components/ui/Toast';
import socket from '../services/socket';

/**
 * Hook that subscribes to server error events and shows toast notifications
 * Also provides a function to request auto-fix for errors
 */
export function useErrorNotifications() {
  const requestAutoFix = useCallback((errorCode, context) => {
    socket.emit('error:recover', { code: errorCode, context });
    toast('Recovery agent dispatched', { icon: '🔧' });
  }, []);

  useEffect(() => {
    // Subscribe to targeted error broadcasts. We listen to ONLY `error:notified`
    // (subscriber-scoped) and skip `error:occurred` (broadcast-to-all) — the
    // server emits both for every error, so listening to both doubled every
    // toast. The Toast layer also dedupes by content as a defense in depth.
    socket.emit('errors:subscribe');

    const handleError = (error) => {
      if (error.code === 'PLATFORM_UNAVAILABLE') {
        toast(error.message, { duration: 5000, icon: '⚠️' });
        console.warn(`[${error.code}] ${error.message}`, error.context);
        return;
      }

      const toastOptions = {
        duration: error.severity === 'critical' ? 10000 : 5000,
        icon: error.severity === 'critical' ? '💥' : '❌'
      };

      const message = error.severity === 'critical'
        ? `Critical: ${error.message}`
        : error.message;

      toast.error(message, toastOptions);
      console.error(`[${error.code}] ${error.message}`, error.context);
    };

    const handleCriticalError = (error) => {
      toast.error(`System Critical: ${error.message}`, {
        duration: 15000,
        icon: '🚨'
      });
    };

    const handleRecoveryRequested = (data) => {
      toast.success(`Auto-fix task created: ${data.taskId}`, {
        duration: 5000,
        icon: '🤖'
      });
    };

    socket.on('error:notified', handleError);
    socket.on('system:critical-error', handleCriticalError);
    socket.on('error:recover:requested', handleRecoveryRequested);

    return () => {
      socket.emit('errors:unsubscribe');
      socket.off('error:notified', handleError);
      socket.off('system:critical-error', handleCriticalError);
      socket.off('error:recover:requested', handleRecoveryRequested);
    };
  }, []);

  return { requestAutoFix };
}
