// Provide draggable, droppable and sortable React bindings for PortOS drag-and-drop surfaces.

import { createContext, createElement, useCallback, useContext, useMemo, useRef } from 'react';
import { DragState } from './context.jsx';
import { activators } from './sensors.js';
import { rectSortingStrategy } from './sortable.js';

export { DndContext, DragOverlay } from './context.jsx';
export { MouseSensor, TouchSensor, PointerSensor, KeyboardSensor, useSensor, useSensors } from './sensors.js';
export { closestCenter, rectIntersection } from './collisions.js';
export { arrayMove, verticalListSortingStrategy, horizontalListSortingStrategy, rectSortingStrategy, sortableKeyboardCoordinates } from './sortable.js';

const SortGroup = createContext(null);

function useEntry({ id, data, disabled }) {
  const node = useRef(null);
  const payload = useRef(data);
  const unavailable = useRef(disabled);
  payload.current = data;
  unavailable.current = disabled;
  return { id, data: payload, disabled: unavailable, node };
}

export function useDraggable(options) {
  const ctx = useContext(DragState);
  const entry = useEntry(options);
  const { node } = entry;
  const activator = useRef(null);
  const setNodeRef = useCallback(el => { node.current = el; }, [node]);
  const setActivatorNodeRef = useCallback(el => { activator.current = el; }, []);
  const isDragging = Boolean(ctx?.view && ctx.view.active.id === entry.id);
  return {
    setNodeRef, setActivatorNodeRef, isDragging,
    transform: isDragging ? { ...ctx.view.sourceDelta, scaleX: 1, scaleY: 1 } : null,
    attributes: { role: 'button', tabIndex: 0, 'aria-disabled': !!options.disabled, 'aria-pressed': isDragging || undefined,
      'aria-roledescription': 'draggable', 'aria-describedby': ctx?.instructions },
    listeners: ctx && !options.disabled ? activators(ctx.sensors, (kind, opts, event, handle) =>
      ctx.begin(entry, kind, opts, event, activator.current ?? handle)) : undefined,
  };
}

export function useDroppable(options) {
  const ctx = useContext(DragState);
  const { id, data, disabled, node } = useEntry(options);
  const registry = ctx?.registry;
  const setNodeRef = useCallback(el => {
    if (el) registry?.set(id, { id, data, get disabled() { return disabled.current; }, node });
    else if (registry?.get(id)?.node === node) registry.delete(id);
    node.current = el;
  }, [id, registry, data, disabled, node]);
  return { setNodeRef, isOver: Boolean(ctx?.view?.over && ctx.view.over.id === id) };
}

export function SortableContext({ items, strategy = rectSortingStrategy, children }) {
  const view = useContext(DragState)?.view;
  const positions = useMemo(() => new Map(items.map((id, index) => [id, index])), [items]);
  const layout = view?.over && {
    positions, strategy, rects: items.map(id => view.droppableRects.get(id)),
    from: positions.get(view.active.id), to: positions.get(view.over.id),
  };
  return createElement(SortGroup.Provider, { value: layout }, children);
}

export function useSortable(options) {
  const layout = useContext(SortGroup);
  const drag = useDraggable(options);
  const { setNodeRef: dropRef } = useDroppable(options);
  const dragRef = drag.setNodeRef;
  const setNodeRef = useCallback(node => { dragRef(node); dropRef(node); }, [dragRef, dropRef]);
  let transform = drag.transform;
  if (layout && !drag.isDragging) {
    const { from, to } = layout;
    const index = layout.positions.get(options.id);
    if (index >= Math.min(from, to) && index <= Math.max(from, to)) {
      transform = layout.strategy({ ...layout, index });
    }
  }
  return { ...drag, setNodeRef, transform, attributes: { ...drag.attributes, 'aria-roledescription': 'sortable' },
    transition: drag.isDragging ? undefined : 'transform 200ms ease' };
}
