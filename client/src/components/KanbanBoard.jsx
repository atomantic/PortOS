import { useState, useEffect, useCallback, useMemo, memo } from 'react';
import {
  DndContext,
  DragOverlay,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import { GripVertical, Play } from 'lucide-react';
import toast from './ui/Toast';
import * as api from '../services/api';
import { FALLBACK_COLUMNS, ticketInColumn, bucketTickets } from '../lib/kanbanColumns.js';

const TICKET_DROP_PREFIX = 'ticket:';

const ticketDropId = (ticketKey) => `${TICKET_DROP_PREFIX}${ticketKey}`;

function dropTargetData(target) {
  return target?.data?.current || {};
}

function columnIdForTarget(target, columns) {
  const columnId = dropTargetData(target).columnId;
  if (columnId) return columnId;
  return columns.some(column => column.id === target?.id) ? target.id : null;
}

function dropTargetLabel(target) {
  const data = dropTargetData(target);
  if (!target) return null;
  if (data.columnName) {
    const position = Number.isInteger(data.position) ? `, position ${data.position + 1}` : '';
    return `${data.columnName}${position}`;
  }
  return `workflow column ${target.id}`;
}

function activeTicketLabel(active) {
  return active?.data?.current?.ticket?.key || active?.id || 'ticket';
}

/**
 * Move keyboard drags between ticket slots and workflow columns.
 *
 * Columns are the fallback target for empty columns. When a destination has
 * tickets, horizontal movement preserves the current slot where possible;
 * vertical movement selects the adjacent slot in the current column.
 */
export function kanbanKeyboardCoordinates(event, { active, context }) {
  const direction = {
    ArrowDown: 1,
    ArrowUp: -1,
    ArrowRight: 1,
    ArrowLeft: -1,
  }[event.code];
  if (!direction) return undefined;

  const activeId = typeof active === 'object' ? active.id : active;
  const activeData = context?.active?.data?.current || active?.data?.current || {};
  const overData = context?.over?.data?.current || {};
  const currentColumnId = overData.columnId || activeData.columnId;
  if (!currentColumnId) return undefined;

  const fallbackPosition = Number.isInteger(activeData.position) ? activeData.position : 0;
  const currentPosition = overData.type === 'ticket' && Number.isInteger(overData.position)
    ? overData.position
    : overData.columnId && overData.columnId !== activeData.columnId
      ? 0
      : fallbackPosition;
  const entries = context?.droppableContainers?.getEnabled?.()
    ?.map(entry => ({
      entry,
      data: entry.data?.current || {},
      rect: context.droppableRects.get(entry.id),
    }))
    .filter(({ entry, rect }) => !entry.disabled && rect) || [];

  const ticketEntries = entries
    .filter(({ data }) => data.type === 'ticket' && String(data.ticketKey) !== String(activeId))
    .sort((left, right) => left.data.position - right.data.position);
  const columnEntries = entries
    .filter(({ data }) => data.type === 'column')
    .sort((left, right) => left.data.columnIndex - right.data.columnIndex);

  let target;
  if (event.code === 'ArrowUp' || event.code === 'ArrowDown') {
    const candidates = ticketEntries.filter(({ data }) => data.columnId === currentColumnId);
    target = direction > 0
      ? candidates.find(({ data }) => data.position > currentPosition)
      : [...candidates].reverse().find(({ data }) => data.position < currentPosition);
  } else {
    const currentColumnIndex = columnEntries.findIndex(({ data }) => data.columnId === currentColumnId);
    const destinationColumn = columnEntries[currentColumnIndex + direction];
    if (!destinationColumn) return undefined;

    const destinationTickets = ticketEntries
      .filter(({ data }) => data.columnId === destinationColumn.data.columnId)
      .sort((left, right) => left.data.position - right.data.position);
    if (destinationTickets.length) {
      const destinationPosition = Math.min(Math.max(currentPosition, 0), destinationTickets.length - 1);
      target = destinationTickets[destinationPosition];
    } else {
      target = destinationColumn;
    }
  }

  if (!target) return undefined;
  return { x: target.rect.left, y: target.rect.top };
}

/** Keep the active ticket's own slot from winning collision detection. */
export function kanbanCollisionDetection(args) {
  const activeDropId = ticketDropId(args.active?.id);
  return closestCenter({
    ...args,
    droppableContainers: args.droppableContainers.filter(entry => entry.id !== activeDropId),
  });
}

const KANBAN_ACCESSIBILITY = {
  announcements: {
    onDragStart({ active }) {
      const ticket = activeTicketLabel(active);
      const source = active?.data?.current?.columnName || 'its current column';
      return `Picked up ticket ${ticket} from ${source}. Use arrow keys to move it, Space to drop, or Escape to cancel.`;
    },
    onDragOver({ active, over }) {
      const ticket = activeTicketLabel(active);
      const destination = dropTargetLabel(over);
      return destination
        ? `Ticket ${ticket} moved over ${destination}.`
        : `Ticket ${ticket} is no longer over a workflow column.`;
    },
    onDragEnd({ active, over }) {
      const ticket = activeTicketLabel(active);
      const destination = dropTargetLabel(over);
      return destination
        ? `Dropped ticket ${ticket} in ${destination}.`
        : `Ticket ${ticket} was dropped outside a workflow column.`;
    },
    onDragCancel({ active }) {
      return `Cancelled dragging ticket ${activeTicketLabel(active)}. It returned to its original column.`;
    },
  },
  screenReaderInstructions: {
    draggable: 'To pick up a ticket, press Space or Enter. While dragging, use the arrow keys to move it between columns and card positions. Press Space to drop the ticket, or Escape to cancel.',
  },
};

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
const DraggableTicket = memo(function DraggableTicket({ ticket, disabled, appId, canQueue, columnId, columnName, columnIndex, position }) {
  const { setNodeRef: setDropNodeRef } = useDroppable({
    id: ticketDropId(ticket.key),
    data: { type: 'ticket', ticketKey: ticket.key, columnId, columnName, columnIndex, position },
    disabled,
  });
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, isDragging } = useDraggable({
    id: ticket.key,
    data: { ticket, columnId, columnName, columnIndex, position },
    disabled
  });
  const [queuing, setQueuing] = useState(false);

  const style = transform ? {
    transform: `translate3d(${transform.x}px, ${transform.y}px, 0)`,
  } : undefined;

  const handleQueue = async () => {
    setQueuing(true);
    // silent: this caller owns its own success/error toasts (see AGENTS.md).
    await api.createJiraTicketTask(appId, ticket.key, { silent: true })
      .then(() => toast.success(`Queued agent task for ${ticket.key}`))
      .catch((err) => toast.error(`Failed to queue ${ticket.key}: ${err.message}`))
      .finally(() => setQueuing(false));
  };

  return (
    <div
      ref={setDropNodeRef}
      style={style}
      className={`group relative ${isDragging ? 'opacity-30' : ''}`}
    >
      <div ref={setNodeRef} className="flex items-stretch gap-0">
        <button
          type="button"
          ref={setActivatorNodeRef}
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

function DroppableColumn({ column, isOver, disabled, appId, columnIndex }) {
  const { setNodeRef } = useDroppable({
    id: column.id,
    data: { type: 'column', columnId: column.id, columnName: column.name, columnIndex },
    disabled,
  });
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
        {column.tickets.map((ticket, position) => (
          <DraggableTicket
            key={ticket.key}
            ticket={ticket}
            disabled={disabled}
            appId={appId}
            canQueue={canQueue}
            columnId={column.id}
            columnName={column.name}
            columnIndex={columnIndex}
            position={position}
          />
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
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: kanbanKeyboardCoordinates })
  );

  const columns = useMemo(() => bucketTickets(boardColumns || FALLBACK_COLUMNS, tickets), [boardColumns, tickets]);

  const handleDragStart = useCallback((event) => {
    const ticket = event.active.data.current?.ticket;
    setActiveTicket(ticket || null);
  }, []);

  const handleDragOver = useCallback((event) => {
    const { over } = event;
    setOverColumn(columnIdForTarget(over, columns));
  }, [columns]);

  const handleDragEnd = useCallback(async (event) => {
    const { active, over } = event;
    setActiveTicket(null);
    setOverColumn(null);

    if (!over) return;

    const targetColumn = columns.find(c => c.id === columnIdForTarget(over, columns));
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
      collisionDetection={kanbanCollisionDetection}
      accessibility={KANBAN_ACCESSIBILITY}
      onDragStart={handleDragStart}
      onDragOver={handleDragOver}
      onDragEnd={handleDragEnd}
      onDragCancel={handleDragCancel}
    >
      <div className="flex gap-3 overflow-x-auto pb-2">
        {columns.map((column, columnIndex) => (
          <DroppableColumn
            key={column.id}
            column={column}
            isOver={overColumn === column.id}
            disabled={!!transitioning}
            appId={appId}
            columnIndex={columnIndex}
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
