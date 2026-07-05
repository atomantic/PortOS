import { useState, useEffect, useCallback, useMemo, memo } from 'react';
import { DndContext, DragOverlay, useDraggable, useDroppable, PointerSensor, useSensor, useSensors } from '@dnd-kit/core';
import { GripVertical, Play } from 'lucide-react';
import toast from './ui/Toast';
import * as api from '../services/api';
import { FALLBACK_COLUMNS, ticketInColumn, bucketTickets } from '../lib/kanbanColumns.js';

// Memoized: rendered once per ticket inside a dnd-kit board that re-renders on
// every pointer move during a drag. Props are a stable ticket object + a
// primitive flag, so memo skips re-rendering cards that aren't being dragged.
const TicketCard = memo(function TicketCard({ ticket, isDragOverlay }) {
  return (
    <div className={`p-2 bg-port-card border border-port-border rounded-lg transition-colors ${isDragOverlay ? 'shadow-lg shadow-black/50 border-port-accent/50 rotate-2' : ''}`}>
      <div className="flex items-start justify-between gap-1">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-xs font-mono text-port-accent">{ticket.key}</span>
            {ticket.priority && (
              <span className={`text-xs ${
                ticket.priority === 'Highest' || ticket.priority === 'High' ? 'text-port-error' :
                ticket.priority === 'Medium' ? 'text-port-warning' : 'text-gray-500'
              }`}>{ticket.priority}</span>
            )}
            {ticket.storyPoints && (
              <span className="text-xs text-cyan-400">{ticket.storyPoints}pt</span>
            )}
          </div>
          <div className="text-xs text-white line-clamp-2">{ticket.summary}</div>
          <div className="text-xs text-gray-500 mt-1">{ticket.issueType}</div>
        </div>
      </div>
    </div>
  );
});

// Memoized for the same reason as TicketCard: only the card actively being
// dragged changes; the rest keep stable ticket/disabled/appId/canQueue props.
const DraggableTicket = memo(function DraggableTicket({ ticket, disabled, appId, canQueue }) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: ticket.key,
    data: { ticket },
    disabled
  });
  const [queuing, setQueuing] = useState(false);

  const style = transform ? {
    transform: `translate3d(${transform.x}px, ${transform.y}px, 0)`,
  } : undefined;

  const handleQueue = async () => {
    setQueuing(true);
    // silent: this caller owns its own success/error toasts (see CLAUDE.md).
    await api.createJiraTicketTask(appId, ticket.key, { silent: true })
      .then(() => toast.success(`Queued agent task for ${ticket.key}`))
      .catch((err) => toast.error(`Failed to queue ${ticket.key}: ${err.message}`))
      .finally(() => setQueuing(false));
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`group relative ${isDragging ? 'opacity-30' : ''}`}
    >
      <div className="flex items-stretch gap-0">
        <button
          type="button"
          {...listeners}
          {...attributes}
          className={`flex items-center px-1 text-gray-600 hover:text-gray-400 shrink-0 ${disabled ? 'cursor-not-allowed opacity-50' : 'cursor-grab active:cursor-grabbing'}`}
          aria-label={`Drag ${ticket.key}`}
          disabled={disabled}
          aria-disabled={disabled}
        >
          <GripVertical size={14} />
        </button>
        <a
          href={ticket.url}
          target="_blank"
          rel="noopener noreferrer"
          className="flex-1 min-w-0 hover:brightness-125 transition-all"
          onClick={(e) => e.stopPropagation()}
        >
          <TicketCard ticket={ticket} />
        </a>
        {canQueue && (
          <button
            type="button"
            onClick={handleQueue}
            disabled={queuing}
            className="flex items-center px-1.5 text-port-success/70 hover:text-port-success shrink-0 disabled:opacity-40 disabled:cursor-not-allowed"
            aria-label={`Start an agent on ${ticket.key}`}
            title={`Queue a Chief of Staff agent to implement ${ticket.key}`}
          >
            <Play size={14} className={queuing ? 'animate-pulse' : ''} />
          </button>
        )}
      </div>
    </div>
  );
});

function DroppableColumn({ column, isOver, disabled, appId }) {
  const { setNodeRef } = useDroppable({ id: column.id, disabled });
  const config = column.config;
  const totalPoints = column.tickets.reduce((sum, t) => sum + (Number(t.storyPoints) || 0), 0);
  // The play button (queue a CoS agent for a ticket) only makes sense for
  // not-started work, and only when we know which app the board belongs to.
  const canQueue = column.category === 'To Do' && !!appId;

  return (
    <div
      ref={setNodeRef}
      className={`flex-1 min-w-[220px] ${config.bg} border ${isOver ? `${config.dropBorder} border-dashed` : config.border} rounded-lg p-3 min-h-[120px] transition-colors`}
    >
      <div className="flex items-center gap-2 mb-3">
        <span className={`w-2 h-2 rounded-full ${config.dot}`} />
        <span className="text-sm font-medium text-white truncate" title={column.name}>{column.name}</span>
        <span className="text-xs text-gray-500">({column.tickets.length})</span>
        {totalPoints > 0 && (
          <span className="text-xs text-cyan-400">{totalPoints}pt</span>
        )}
      </div>
      <div className="space-y-2">
        {column.tickets.map(ticket => (
          <DraggableTicket key={ticket.key} ticket={ticket} disabled={disabled} appId={appId} canQueue={canQueue} />
        ))}
        {column.tickets.length === 0 && (
          <div className={`text-xs text-center py-4 ${isOver ? 'text-gray-300' : 'text-gray-500'}`}>
            {isOver ? 'Drop here' : 'No tickets'}
          </div>
        )}
      </div>
    </div>
  );
}

export default function KanbanBoard({ tickets: initialTickets = [], instanceId, onTicketsChange, appId, projectKey, boardId }) {
  const [tickets, setTickets] = useState(initialTickets);
  const [activeTicket, setActiveTicket] = useState(null);
  const [transitioning, setTransitioning] = useState(null);
  const [overColumn, setOverColumn] = useState(null);
  const [boardColumns, setBoardColumns] = useState(null);

  // Sync if parent re-fetches
  useEffect(() => { setTickets(initialTickets); }, [initialTickets]);

  // Resolve the full workflow lifecycle (Blocked, In Review, custom stages) for
  // this project's board. Silent — on failure we keep the three-category
  // fallback rather than surfacing a toast for a non-critical enhancement.
  useEffect(() => {
    if (!instanceId || !projectKey) {
      setBoardColumns(null);
      return;
    }
    let cancelled = false;
    api.getJiraBoardColumns(instanceId, projectKey, boardId, { silent: true })
      .then(res => { if (!cancelled) setBoardColumns(res?.columns?.length ? res.columns : null); })
      .catch(() => { if (!cancelled) setBoardColumns(null); });
    return () => { cancelled = true; };
  }, [instanceId, projectKey, boardId]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } })
  );

  const columns = useMemo(() => bucketTickets(boardColumns || FALLBACK_COLUMNS, tickets), [boardColumns, tickets]);

  const handleDragStart = useCallback((event) => {
    const ticket = event.active.data.current?.ticket;
    setActiveTicket(ticket || null);
  }, []);

  const handleDragOver = useCallback((event) => {
    const { over } = event;
    setOverColumn(over?.id && columns.some(c => c.id === over.id) ? over.id : null);
  }, [columns]);

  const handleDragEnd = useCallback(async (event) => {
    const { active, over } = event;
    setActiveTicket(null);
    setOverColumn(null);

    if (!over) return;

    const targetColumn = columns.find(c => c.id === over.id);
    if (!targetColumn) return;

    const ticket = active.data.current?.ticket;
    if (!ticket) return;

    // Already in this column? Nothing to do.
    if (ticketInColumn(ticket, targetColumn)) return;

    if (!instanceId) {
      toast.error('Cannot transition: no JIRA instance configured');
      return;
    }

    // Optimistic update — notify parent immediately so cache stays in sync.
    // We know the target category now; the exact status name is corrected once
    // the matching transition is resolved below.
    const previousTickets = [...tickets];
    const optimistic = tickets.map(t =>
      t.key === ticket.key
        ? { ...t, statusCategory: targetColumn.category, status: targetColumn.statuses[0] || t.status }
        : t
    );
    setTickets(optimistic);
    onTicketsChange?.(optimistic);
    setTransitioning(ticket.key);

    try {
      // Fetch available transitions and find one that lands in the target column.
      const transitions = await api.getJiraTicketTransitions(instanceId, ticket.key, { silent: true });
      const match = transitions.find(t =>
        targetColumn.statuses.length
          ? targetColumn.statuses.includes(t.to)
          : t.toCategory === targetColumn.category
      );

      if (!match) {
        // Rollback — sync parent cache
        setTickets(previousTickets);
        onTicketsChange?.(previousTickets);
        toast.error(`No transition available to "${targetColumn.name}" for ${ticket.key}`);
        return;
      }

      await api.transitionJiraTicket(instanceId, ticket.key, match.id, { silent: true });
      // Update the status name + category from the resolved transition.
      const nextTickets = optimistic.map(t =>
        t.key === ticket.key ? { ...t, status: match.to, statusCategory: match.toCategory } : t
      );
      setTickets(nextTickets);
      onTicketsChange?.(nextTickets);
      toast.success(`${ticket.key} moved to ${match.to}`);
    } catch (err) {
      setTickets(previousTickets);
      onTicketsChange?.(previousTickets);
      toast.error(`Failed to transition ${ticket.key}: ${err.message}`);
    } finally {
      setTransitioning(null);
    }
  }, [columns, tickets, instanceId, onTicketsChange]);

  const handleDragCancel = useCallback(() => {
    setActiveTicket(null);
    setOverColumn(null);
  }, []);

  return (
    <DndContext
      sensors={sensors}
      onDragStart={handleDragStart}
      onDragOver={handleDragOver}
      onDragEnd={handleDragEnd}
      onDragCancel={handleDragCancel}
    >
      <div className="flex gap-3 overflow-x-auto pb-2">
        {columns.map(column => (
          <DroppableColumn
            key={column.id}
            column={column}
            isOver={overColumn === column.id}
            disabled={!!transitioning}
            appId={appId}
          />
        ))}
      </div>
      <DragOverlay>
        {activeTicket ? <TicketCard ticket={activeTicket} isDragOverlay /> : null}
      </DragOverlay>
      {transitioning && (
        <div className="text-xs text-gray-400 text-center mt-2 animate-pulse">
          Transitioning {transitioning}...
        </div>
      )}
    </DndContext>
  );
}
