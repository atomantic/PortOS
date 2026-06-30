import { useEffect, useCallback } from 'react';
import toast from '../components/ui/Toast';
import socket from '../services/socket';

// Render an error's context object as a single-line suffix (empty when absent)
// so the console stays on one interpolated line instead of expanding a group.
const formatContext = (context) => (context ? ` ${JSON.stringify(context)}` : '');

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
      // A degraded DB backup is warning-severity (the file backup succeeded)
      // but MUST still surface — its whole point is "find out the day it
      // breaks," including on unattended scheduled runs. Handle it before the
      // blanket warning-drop below.
      if (error.code === 'BACKUP_DB_DUMP_FAILED') {
        toast.error(error.message, { duration: 8000, icon: '💾' });
        console.warn(`[${error.code}] ${error.message}${formatContext(error.context)}`);
        return;
      }

      // A model declined a prompt on content/safety grounds. Not an error —
      // the server is auto-retrying with a fallback model. Surface a calm,
      // informative notice (not a red error toast) so the user knows why their
      // primary model balked. Handled before the warning-drop below.
      if (error.code === 'AI_PROVIDER_CONTENT_REFUSED') {
        toast(error.message, { duration: 7000, icon: '🛟' });
        console.warn(`[${error.code}] ${error.message}${formatContext(error.context)}`);
        return;
      }

      // `severity: 'warning'` routes (e.g. speculative GET /api/media-jobs/:id
      // 404s for jobs past the 24h archive TTL) opt out of toast + console
      // surfacing entirely — the network-tab 404 is sufficient signal.
      if (error.severity === 'warning') return;

      if (error.code === 'PLATFORM_UNAVAILABLE') {
        toast(error.message, { duration: 5000, icon: '⚠️' });
        console.warn(`[${error.code}] ${error.message}${formatContext(error.context)}`);
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
      console.error(`[${error.code}] ${error.message}${formatContext(error.context)}`);
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
