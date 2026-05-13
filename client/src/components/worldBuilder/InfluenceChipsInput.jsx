import { useState } from 'react';
import { X, GripVertical } from 'lucide-react';
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  rectSortingStrategy,
  sortableKeyboardCoordinates,
  useSortable,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { WORLD_INFLUENCE_ENTRY_MAX, WORLD_INFLUENCES_PER_LIST_MAX } from '../../services/api';

const TONE_CLASS = {
  success: 'bg-port-success/15 text-port-success border-port-success/40',
  error: 'bg-port-error/15 text-port-error border-port-error/40',
  accent: 'bg-port-accent/20 text-port-accent border-port-accent/40',
};

/**
 * Chip input for an influence list (embrace or avoid). Used by both the
 * inline World Builder editor and the Refine modal — extracting one
 * implementation keeps Enter/comma/paste/Backspace behavior, dedupe rules,
 * per-entry caps, and drag-to-reorder in lockstep across both surfaces.
 *
 * Order is meaningful: the renderer prepends embrace + avoid to
 * stylePrompt/negativePrompt verbatim, so dragging a chip toward the front
 * gives it priority in the rendered prompt.
 *
 * `readOnly` collapses the editor to a plain chip preview (no input, no X
 * buttons, no drag handles) so locked influences render with the same chrome.
 */
export default function InfluenceChipsInput({
  tokens,
  onChange,
  tone = 'accent',
  placeholder = 'Add reference, press Enter',
  readOnly = false,
  emptyLabel = '(none)',
}) {
  const [input, setInput] = useState('');
  const safe = Array.isArray(tokens) ? tokens : [];
  const toneClass = TONE_CLASS[tone] || TONE_CLASS.accent;

  // 8px activation distance keeps single clicks on the X button (remove) and
  // the trailing input from accidentally triggering a drag — drag has to be
  // a deliberate gesture. Keyboard sensor enables accessible reordering via
  // space/enter to grab + arrow keys.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  if (readOnly && safe.length === 0) {
    return <div className="text-[11px] text-gray-600">{emptyLabel}</div>;
  }

  const commit = (raw) => {
    const incoming = (raw || '')
      .split(/[,\n]/)
      .map((t) => t.trim())
      .filter(Boolean)
      .map((t) => t.slice(0, WORLD_INFLUENCE_ENTRY_MAX));
    if (!incoming.length) return;
    const seen = new Set(safe.map((v) => v.toLowerCase()));
    const next = [...safe];
    for (const t of incoming) {
      const key = t.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      next.push(t);
      if (next.length >= WORLD_INFLUENCES_PER_LIST_MAX) break;
    }
    onChange(next);
    setInput('');
  };

  const removeAt = (idx) => onChange(safe.filter((_, i) => i !== idx));

  const handleDragEnd = (event) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIdx = safe.findIndex((t) => t === active.id);
    const newIdx = safe.findIndex((t) => t === over.id);
    if (oldIdx === -1 || newIdx === -1) return;
    onChange(arrayMove(safe, oldIdx, newIdx));
  };

  const containerCls = `flex flex-wrap items-center gap-1.5 p-2 bg-port-bg border border-port-border rounded ${readOnly ? 'opacity-70' : ''}`;

  // Read-only path: no DnD wrapper, no input, no remove buttons — just chips.
  if (readOnly) {
    return (
      <div className={containerCls}>
        {safe.map((v, idx) => (
          <span
            key={`${v}-${idx}`}
            className={`inline-flex items-center gap-1 px-2 py-0.5 text-xs rounded-full border ${toneClass}`}
          >
            {v}
          </span>
        ))}
      </div>
    );
  }

  return (
    <div className={containerCls}>
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext items={safe} strategy={rectSortingStrategy}>
          {safe.map((v, idx) => (
            <SortableChip
              key={v}
              token={v}
              toneClass={toneClass}
              onRemove={() => removeAt(idx)}
            />
          ))}
        </SortableContext>
      </DndContext>
      {safe.length < WORLD_INFLUENCES_PER_LIST_MAX && (
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ',') {
              e.preventDefault();
              commit(input);
            } else if (e.key === 'Backspace' && !input && safe.length) {
              onChange(safe.slice(0, -1));
            }
          }}
          onBlur={() => commit(input)}
          onPaste={(e) => {
            const text = e.clipboardData.getData('text');
            if (text && /[,\n]/.test(text)) {
              e.preventDefault();
              commit(text);
            }
          }}
          placeholder={placeholder}
          maxLength={WORLD_INFLUENCE_ENTRY_MAX}
          className="flex-1 min-w-[120px] bg-transparent text-sm text-white placeholder-gray-500 focus:outline-none"
        />
      )}
      {safe.length >= WORLD_INFLUENCES_PER_LIST_MAX && (
        <span className="text-[11px] text-gray-500">Max {WORLD_INFLUENCES_PER_LIST_MAX} reached</span>
      )}
    </div>
  );
}

function SortableChip({ token, toneClass, onRemove }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: token });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
    zIndex: isDragging ? 10 : 'auto',
  };
  return (
    <span
      ref={setNodeRef}
      style={style}
      className={`inline-flex items-center gap-1 pl-1 pr-2 py-0.5 text-xs rounded-full border ${toneClass} ${isDragging ? 'cursor-grabbing' : ''}`}
    >
      <button
        type="button"
        {...attributes}
        {...listeners}
        className="cursor-grab active:cursor-grabbing text-current/60 hover:text-current focus:outline-none"
        aria-label={`Drag ${token} to reorder`}
        title="Drag to reorder"
      >
        <GripVertical size={11} />
      </button>
      {token}
      <button
        type="button"
        onClick={onRemove}
        onPointerDown={(e) => e.stopPropagation()}
        className="text-current/70 hover:text-current"
        aria-label={`Remove ${token}`}
      >
        <X size={11} />
      </button>
    </span>
  );
}
