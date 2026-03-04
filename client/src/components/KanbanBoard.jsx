import { useState, useEffect, useCallback } from 'react';
import { DndContext, DragOverlay, useDraggable, useDroppable, PointerSensor, useSensor, useSensors } from '@dnd-kit/core';
import { GripVertical } from 'lucide-react';
import toast from 'react-hot-toast';
import * as api from '../services/api';

const COLUMNS = ['To Do', 'In Progress', 'Done'];

const COLUMN_CONFIG = {
  'To Do': { bg: 'bg-gray-500/10', border: 'border-gray-500/30', dot: 'bg-gray-500', dropBorder: 'border-gray-400' },
  'In Progress': { bg: 'bg-port-accent/10', border: 'border-port-accent/30', dot: 'bg-port-accent', dropBorder: 'border-port-accent' },
  'Done': { bg: 'bg-port-success/10', border: 'border-port-success/30', dot: 'bg-port-success', dropBorder: 'border-port-success' }
};

function TicketCard({ ticket, isDragOverlay }) {
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
}

function DraggableTicket({ ticket, disabled }) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: ticket.key,
    data: { ticket },
    disabled
  });

  const style = transform ? {
    transform: `translate3d(${transform.x}px, ${transform.y}px, 0)`,
  } : undefined;

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`group relative ${isDragging ? 'opacity-30' : ''}`}
    >
      <div className="flex items-stretch gap-0">
        <button
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
      </div>
    </div>
  );
}

function DroppableColumn({ category, tickets, isOver, disabled }) {
  const { setNodeRef } = useDroppable({ id: category, disabled });
  const config = COLUMN_CONFIG[category];

  return (
    <div
      ref={setNodeRef}
      className={`${config.bg} border ${isOver ? `${config.dropBorder} border-dashed` : config.border} rounded-lg p-3 min-h-[120px] transition-colors`}
    >
      <div className="flex items-center gap-2 mb-3">
        <span className={`w-2 h-2 rounded-full ${config.dot}`} />
        <span className="text-sm font-medium text-white">{category}</span>
        <span className="text-xs text-gray-500">({tickets.length})</span>
      </div>
      <div className="space-y-2">
        {tickets.map(ticket => (
          <DraggableTicket key={ticket.key} ticket={ticket} disabled={disabled} />
        ))}
        {tickets.length === 0 && (
          <div className={`text-xs text-center py-4 ${isOver ? 'text-gray-300' : 'text-gray-500'}`}>
            {isOver ? 'Drop here' : 'No tickets'}
          </div>
        )}
      </div>
    </div>
  );
}

export default function KanbanBoard({ tickets: initialTickets, instanceId, onTicketsChange }) {
  const [tickets, setTickets] = useState(initialTickets);
  const [activeTicket, setActiveTicket] = useState(null);
  const [transitioning, setTransitioning] = useState(null);
  const [overColumn, setOverColumn] = useState(null);

  // Sync if parent re-fetches
  useEffect(() => { setTickets(initialTickets); }, [initialTickets]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } })
  );

  const columns = {};
  for (const col of COLUMNS) {
    columns[col] = tickets.filter(t => t.statusCategory === col);
  }

  const handleDragStart = useCallback((event) => {
    const ticket = event.active.data.current?.ticket;
    setActiveTicket(ticket || null);
  }, []);

  const handleDragOver = useCallback((event) => {
    const { over } = event;
    setOverColumn(over?.id && COLUMNS.includes(over.id) ? over.id : null);
  }, []);

  const handleDragEnd = useCallback(async (event) => {
    const { active, over } = event;
    setActiveTicket(null);
    setOverColumn(null);

    if (!over || !COLUMNS.includes(over.id)) return;

    const ticket = active.data.current?.ticket;
    if (!ticket) return;

    const targetCategory = over.id;
    if (ticket.statusCategory === targetCategory) return;

    if (!instanceId) {
      toast.error('Cannot transition: no JIRA instance configured');
      return;
    }

    // Optimistic update — notify parent immediately so cache stays in sync
    const previousTickets = [...tickets];
    setTickets(prev => {
      const optimistic = prev.map(t =>
        t.key === ticket.key ? { ...t, statusCategory: targetCategory } : t
      );
      onTicketsChange?.(optimistic);
      return optimistic;
    });
    setTransitioning(ticket.key);

    try {
      // Fetch available transitions and find matching one
      const transitions = await api.getJiraTicketTransitions(instanceId, ticket.key, { silent: true });
      const match = transitions.find(t => t.toCategory === targetCategory);

      if (!match) {
        // Rollback — sync parent cache
        setTickets(previousTickets);
        onTicketsChange?.(previousTickets);
        toast.error(`No transition available to "${targetCategory}" for ${ticket.key}`);
        return;
      }

      await api.transitionJiraTicket(instanceId, ticket.key, match.id, { silent: true });
      // Update the status name too, based on latest state
      setTickets(prev => {
        const updated = prev.map(t =>
          t.key === ticket.key ? { ...t, status: match.to, statusCategory: targetCategory } : t
        );
        onTicketsChange?.(updated);
        return updated;
      });
      toast.success(`${ticket.key} moved to ${match.to}`);
    } catch (err) {
      setTickets(previousTickets);
      onTicketsChange?.(previousTickets);
      toast.error(`Failed to transition ${ticket.key}: ${err.message}`);
    } finally {
      setTransitioning(null);
    }
  }, [tickets, instanceId, onTicketsChange]);

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
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        {COLUMNS.map(category => (
          <DroppableColumn
            key={category}
            category={category}
            tickets={columns[category]}
            isOver={overColumn === category}
            disabled={!!transitioning}
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
