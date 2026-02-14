import { useEffect, useCallback } from 'react';
import toast from 'react-hot-toast';
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
    // Subscribe to error events
    socket.emit('errors:subscribe');

    // Handle error notifications from server
    const handleError = (error) => {
      // Platform unavailability is a warning, not an error
      if (error.code === 'PLATFORM_UNAVAILABLE') {
        toast(error.message, { duration: 5000, icon: '⚠️' });
        console.warn(`[${error.code}] ${error.message}`, error.context);
        return;
      }

      const toastOptions = {
        duration: error.severity === 'critical' ? 10000 : 5000,
        icon: error.severity === 'critical' ? '💥' : '❌'
      };

      // Format message based on severity
      const message = error.severity === 'critical'
        ? `Critical: ${error.message}`
        : error.message;

      toast.error(message, toastOptions);

      // Log to console for debugging
      console.error(`[${error.code}] ${error.message}`, error.context);
    };

    // Handle critical system errors
    const handleCriticalError = (error) => {
      toast.error(`System Critical: ${error.message}`, {
        duration: 15000,
        icon: '🚨'
      });
    };

    // Handle auto-fix task creation notifications
    const handleRecoveryRequested = (data) => {
      toast.success(`Auto-fix task created: ${data.taskId}`, {
        duration: 5000,
        icon: '🤖'
      });
    };

    // Register handlers
    socket.on('error:occurred', handleError);
    socket.on('error:notified', handleError);
    socket.on('system:critical-error', handleCriticalError);
    socket.on('error:recover:requested', handleRecoveryRequested);

    return () => {
      socket.emit('errors:unsubscribe');
      socket.off('error:occurred', handleError);
      socket.off('error:notified', handleError);
      socket.off('system:critical-error', handleCriticalError);
      socket.off('error:recover:requested', handleRecoveryRequested);
    };
  }, []);

  return { requestAutoFix };
}
