import { useState } from 'react';
import { X } from 'lucide-react';
import toast from '../../ui/Toast';
import ListLoadError from '../../ui/ListLoadError';
import { moltworldAddToQueue, moltworldGetQueue, moltworldRemoveFromQueue } from '../../../services/apiAccounts.js';
import { useSocketResource } from '../../../hooks/useSocketResource';
import { WORLD_ACTION_ICONS, summarizeWorldAction } from './worldActionDisplay';

// Module-level so the resource keeps one stable subscription across renders.
const QUEUE_EVENTS = ['moltworld:queue:added', 'moltworld:queue:updated', 'moltworld:queue:removed'];

const QUEUE_ACTION_TYPES = [
  { value: 'mw_explore', label: 'Explore' },
  { value: 'mw_think', label: 'Think' },
  { value: 'mw_build', label: 'Build' },
  { value: 'mw_say', label: 'Say' }
];

const QUEUE_STATUS_STYLES = {
  pending: 'bg-gray-600/20 text-gray-400',
  executing: 'bg-port-accent/20 text-port-accent animate-pulse',
  completed: 'bg-port-success/20 text-port-success',
  failed: 'bg-port-error/20 text-port-error'
};

export function useWorldQueue({ agentId, accountId }) {
  const { data: queueData, loading: queueLoading, error: queueError, refetch: refetchQueue } = useSocketResource(
    () => moltworldGetQueue(agentId),
    { events: QUEUE_EVENTS, resourceKey: agentId, enabled: Boolean(accountId) }
  );
  const queue = queueData ?? [];
  const [showAddForm, setShowAddForm] = useState(false);
  const [newActionType, setNewActionType] = useState('mw_explore');
  const [newActionParams, setNewActionParams] = useState({});

  const handleAddToQueue = async () => {
    const params = { ...newActionParams };
    // Convert numeric fields
    if (params.x != null) params.x = parseInt(params.x, 10);
    if (params.y != null) params.y = parseInt(params.y, 10);
    if (params.z != null) params.z = parseInt(params.z, 10);

    try {
      await moltworldAddToQueue({ agentId, actionType: newActionType, params });
    } catch {
      return;
    }
    setShowAddForm(false);
    setNewActionParams({});
    toast.success('Action queued');
  };

  const handleRemoveFromQueue = async (id) => {
    await moltworldRemoveFromQueue(id).catch(() => null);
  };

  return {
    queue, queueError, queueLoading, refetchQueue,
    showAddForm, setShowAddForm, newActionType, setNewActionType, newActionParams, setNewActionParams,
    handleAddToQueue, handleRemoveFromQueue
  };
}

export default function WorldQueueSection({
  queue, queueError, queueLoading, refetchQueue,
  showAddForm, setShowAddForm, newActionType, setNewActionType, newActionParams, setNewActionParams,
  handleAddToQueue, handleRemoveFromQueue
}) {
  // Dynamic param fields for add-to-queue form
  const renderQueueParamFields = () => {
    switch (newActionType) {
      case 'mw_explore':
        return (
          <div className="grid grid-cols-2 gap-2">
            <input type="number" placeholder="X" aria-label="Queued action X coordinate" value={newActionParams.x || ''} onChange={e => setNewActionParams(p => ({ ...p, x: e.target.value }))} className="px-2 py-1.5 bg-port-bg border border-port-border rounded text-white text-sm" />
            <input type="number" placeholder="Y" aria-label="Queued action Y coordinate" value={newActionParams.y || ''} onChange={e => setNewActionParams(p => ({ ...p, y: e.target.value }))} className="px-2 py-1.5 bg-port-bg border border-port-border rounded text-white text-sm" />
            <input type="text" placeholder="Thinking (optional)" aria-label="Queued action thinking (optional)" value={newActionParams.thinking || ''} onChange={e => setNewActionParams(p => ({ ...p, thinking: e.target.value }))} className="col-span-2 px-2 py-1.5 bg-port-bg border border-port-border rounded text-white text-sm" />
          </div>
        );
      case 'mw_think':
        return (
          <input type="text" placeholder="Thought text" aria-label="Queued thought text" value={newActionParams.thought || ''} onChange={e => setNewActionParams(p => ({ ...p, thought: e.target.value }))} className="w-full px-2 py-1.5 bg-port-bg border border-port-border rounded text-white text-sm" />
        );
      case 'mw_build':
        return (
          <div className="grid grid-cols-3 gap-2">
            <input type="number" placeholder="X" aria-label="Queued action X coordinate" value={newActionParams.x || ''} onChange={e => setNewActionParams(p => ({ ...p, x: e.target.value }))} className="px-2 py-1.5 bg-port-bg border border-port-border rounded text-white text-sm" />
            <input type="number" placeholder="Y" aria-label="Queued action Y coordinate" value={newActionParams.y || ''} onChange={e => setNewActionParams(p => ({ ...p, y: e.target.value }))} className="px-2 py-1.5 bg-port-bg border border-port-border rounded text-white text-sm" />
            <input type="number" placeholder="Z" aria-label="Queued action Z coordinate" value={newActionParams.z || ''} onChange={e => setNewActionParams(p => ({ ...p, z: e.target.value }))} className="px-2 py-1.5 bg-port-bg border border-port-border rounded text-white text-sm" />
            <select aria-label="Queued build block type" value={newActionParams.type || 'stone'} onChange={e => setNewActionParams(p => ({ ...p, type: e.target.value }))} className="px-2 py-1.5 bg-port-bg border border-port-border rounded text-white text-sm">
              <option value="wood">Wood</option>
              <option value="stone">Stone</option>
              <option value="dirt">Dirt</option>
              <option value="grass">Grass</option>
              <option value="leaves">Leaves</option>
            </select>
            <select aria-label="Queued build action" value={newActionParams.action || 'place'} onChange={e => setNewActionParams(p => ({ ...p, action: e.target.value }))} className="px-2 py-1.5 bg-port-bg border border-port-border rounded text-white text-sm">
              <option value="place">Place</option>
              <option value="remove">Remove</option>
            </select>
          </div>
        );
      case 'mw_say':
        return (
          <div className="space-y-2">
            <input type="text" placeholder="Message" aria-label="Queued message" value={newActionParams.message || ''} onChange={e => setNewActionParams(p => ({ ...p, message: e.target.value }))} className="w-full px-2 py-1.5 bg-port-bg border border-port-border rounded text-white text-sm" />
            <input type="text" placeholder="To Agent ID (optional)" aria-label="Queued message recipient agent ID (optional)" value={newActionParams.sayTo || ''} onChange={e => setNewActionParams(p => ({ ...p, sayTo: e.target.value }))} className="w-full px-2 py-1.5 bg-port-bg border border-port-border rounded text-white text-sm" />
          </div>
        );
      default:
        return null;
    }
  };

  return (
    <div className="bg-port-card border border-port-border rounded-lg p-4">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
        <h3 className="font-semibold text-white min-w-0">Action Queue</h3>
        <div className="flex flex-wrap items-center gap-2">
          {queue.length > 0 && (
            <span className="text-xs text-gray-500">{queue.length} item{queue.length !== 1 ? 's' : ''}</span>
          )}
          <button
            onClick={() => { setShowAddForm(!showAddForm); setNewActionParams({}); }}
            className="pointer-coarse:min-h-11 px-2 py-1 text-xs bg-port-accent text-white rounded hover:bg-port-accent/80"
          >
            {showAddForm ? 'Cancel' : '+ Add'}
          </button>
        </div>
      </div>

      {showAddForm && (
        <div className="mb-3 p-3 bg-port-bg border border-port-border rounded space-y-2">
          <select
            aria-label="Action type"
            value={newActionType}
            onChange={e => { setNewActionType(e.target.value); setNewActionParams({}); }}
            className="w-full px-2 py-1.5 bg-port-card border border-port-border rounded text-white text-sm"
          >
            {QUEUE_ACTION_TYPES.map(t => (
              <option key={t.value} value={t.value}>{t.label}</option>
            ))}
          </select>
          {renderQueueParamFields()}
          <button
            onClick={handleAddToQueue}
            className="w-full px-3 py-1.5 text-sm bg-port-accent text-white rounded hover:bg-port-accent/80"
          >
            Add to Queue
          </button>
        </div>
      )}

      {queueError && (
        <ListLoadError what="action queue" error={queueError} onRetry={refetchQueue} retrying={queueLoading} className="mb-2" />
      )}
      {queue.length === 0 && !queueLoading && !queueError ? (
        <p className="text-sm text-gray-500 text-center py-4">No queued actions</p>
      ) : (
        <div className="space-y-1.5 max-h-[300px] overflow-y-auto">
          {queue.map((item) => (
            <div key={item.id} className="flex items-center gap-2 p-2 bg-port-bg rounded text-xs">
              <span className="shrink-0">{WORLD_ACTION_ICONS[item.actionType] || '📋'}</span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="text-gray-300 font-medium">{item.actionType?.replace('mw_', '')}</span>
                  <span className={`px-1 py-0.5 rounded text-[10px] ${QUEUE_STATUS_STYLES[item.status] || ''}`}>
                    {item.status}
                  </span>
                </div>
                <p className="text-gray-500 truncate mt-0.5">
                  {summarizeWorldAction(item.actionType, item.params)}
                </p>
              </div>
              {item.status === 'pending' && (
                <button
                  type="button"
                  aria-label={`Cancel pending ${item.actionType?.replace('mw_', '') || 'action'}`}
                  onClick={() => handleRemoveFromQueue(item.id)}
                  className="inline-flex items-center justify-center shrink-0 text-gray-500 hover:text-port-error pointer-coarse:min-h-11 pointer-coarse:min-w-11"
                >
                  <X size={14} aria-hidden="true" />
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
