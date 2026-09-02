import { useEffect, useRef } from 'react';
import socket from '../services/socket';

/**
 * Subscribes a surface to the shared CoS task lifecycle and forwards each task
 * update to its current reducer without resubscribing on ordinary rerenders.
 */
export function useCosTaskUpdates(onTaskUpdate) {
  const onTaskUpdateRef = useRef(onTaskUpdate);
  onTaskUpdateRef.current = onTaskUpdate;

  useEffect(() => {
    const subscribe = () => socket.emit('cos:subscribe');
    const emitTaskUpdate = task => {
      if (task) onTaskUpdateRef.current?.(task);
    };
    const handleTaskChanged = event => emitTaskUpdate(event?.task);
    const handleTaskListChanged = event => {
      for (const task of event?.tasks || []) emitTaskUpdate(task);
    };
    const handleTaskCompleted = event => {
      for (const task of event?.tasks || []) emitTaskUpdate(task);
    };
    const handleAgentSpawned = agent => {
      if (agent?.taskId) emitTaskUpdate({ id: agent.taskId, status: 'in_progress' });
    };
    const handleAgentCompleted = agent => {
      // A failed agent can be requeued or blocked by its completion path, so
      // only the success signal is safe as an early terminal hint. The task
      // lifecycle event remains authoritative for all outcomes.
      if (agent?.taskId && agent.result?.success === true) {
        emitTaskUpdate({ id: agent.taskId, status: 'completed' });
      }
    };

    subscribe();
    socket.on('connect', subscribe);
    socket.on('cos:tasks:changed', handleTaskChanged);
    socket.on('cos:tasks:user:changed', handleTaskListChanged);
    socket.on('cos:tasks:user:completed', handleTaskCompleted);
    socket.on('cos:agent:spawned', handleAgentSpawned);
    socket.on('cos:agent:completed', handleAgentCompleted);

    return () => {
      socket.off('connect', subscribe);
      socket.off('cos:tasks:changed', handleTaskChanged);
      socket.off('cos:tasks:user:changed', handleTaskListChanged);
      socket.off('cos:tasks:user:completed', handleTaskCompleted);
      socket.off('cos:agent:spawned', handleAgentSpawned);
      socket.off('cos:agent:completed', handleAgentCompleted);
    };
  }, []);
}
