// Coordinate a single active drag, resolve measured drop targets, and expose its overlay and accessible announcements.

import { createContext, useCallback, useContext, useEffect, useId, useRef, useState } from 'react';
import { createPortal, flushSync } from 'react-dom';
import { rectIntersection } from './collisions.js';
import { attachSensor, TouchSensor } from './sensors.js';

export const DragState = createContext(null);
const defaultAnnouncements = {
  onDragStart: ({ active }) => `Picked up draggable item ${active.id}.`,
  onDragOver: ({ over }) => over ? `Over drop target ${over.id}.` : 'Outside a drop target.',
  onDragEnd: ({ active, over }) => over ? `Dropped ${active.id} on ${over.id}.` : `Dropped ${active.id} outside a drop target.`,
  onDragCancel: ({ active }) => `Cancelled dragging ${active.id}.`,
};

function translated(rect, delta) {
  const left = rect.left + delta.x;
  const top = rect.top + delta.y;
  return { left, top, x: left, y: top, right: left + rect.width, bottom: top + rect.height, width: rect.width, height: rect.height };
}

function measure(node) {
  // Sortable siblings can already have CSS transforms on the next move. Keep their untransformed layout, updating viewport coordinates when ancestors scroll.
  const rect = node.getBoundingClientRect();
  const ancestors = [];
  for (let parent = node.parentElement; parent; parent = parent.parentElement) {
    if (parent.scrollWidth > parent.clientWidth || parent.scrollHeight > parent.clientHeight) {
      ancestors.push({ parent, x: parent.scrollLeft, y: parent.scrollTop });
    }
  }
  return () => {
    const delta = { x: 0, y: 0 };
    for (const { parent, x, y } of ancestors) { delta.x += x - parent.scrollLeft; delta.y += y - parent.scrollTop; }
    return translated(rect, delta);
  };
}

export function DndContext({ children, sensors = [], collisionDetection = rectIntersection, accessibility, ...callbacks }) {
  const registry = useRef(new Map()).current;
  const tracking = useRef(null);
  const props = useRef(null);
  props.current = { collisionDetection, accessibility, callbacks };
  const [view, setView] = useState(null);
  const [message, setMessage] = useState('');
  const instructions = 'DndInstructions' + useId();
  useEffect(() => () => tracking.current?.dispose?.(), []);
  const listensForTouch = sensors.some(({ sensor }) => sensor === TouchSensor);
  useEffect(() => {
    if (!listensForTouch) return;
    // Safari decides at touchstart whether a later touchmove can prevent scrolling after a long press.
    const allowCancellation = () => {};
    window.addEventListener('touchmove', allowCancellation, { passive: false });
    return () => window.removeEventListener('touchmove', allowCancellation);
  }, [listensForTouch]);

  const begin = useCallback((source, kind, options, event, handle) => {
    if (tracking.current || !source.node.current || source.disabled.current) return;
    const session = {};
    tracking.current = session;
    const measured = new Map();
    let active;
    let sourcePosition;
    let pointer;
    let over = null;
    let delta = { x: 0, y: 0 };
    let droppableRects;
    let enabled;
    const notify = name => {
      const detail = { active, over, delta, activatorEvent: event };
      const announcement = (props.current.accessibility?.announcements?.[name] ?? defaultAnnouncements[name])(detail);
      if (announcement != null) setMessage(announcement);
      props.current.callbacks[name]?.(detail);
    };
    const update = (nextDelta, pointerCoordinates) => {
      delta = nextDelta;
      pointer = pointerCoordinates;
      active.rect.current.translated = translated(active.rect.current.initial, delta);
      enabled = [...registry.values()].filter(entry => entry.node.current && !entry.disabled);
      droppableRects = new Map();
      for (const entry of enabled) {
        const node = entry.node.current;
        if (!measured.has(node)) measured.set(node, measure(node));
        droppableRects.set(entry.id, measured.get(node)());
      }
      const hits = props.current.collisionDetection({ active, pointerCoordinates, collisionRect: active.rect.current.translated, droppableRects, droppableContainers: enabled });
      const entry = registry.get(hits[0]?.id);
      const previousId = over?.id;
      over = entry ? { id: entry.id, data: entry.data, rect: droppableRects.get(entry.id), disabled: false } : null;
      const origin = sourcePosition();
      const sourceDelta = { x: active.rect.current.translated.left - origin.left, y: active.rect.current.translated.top - origin.top };
      setView({ active, over, delta, sourceDelta, droppableRects });
      if (previousId !== over?.id) notify('onDragOver');
    };
    const actions = {
      start(pointerCoordinates) {
        if (!source.node.current || source.disabled.current) return;
        sourcePosition = measure(source.node.current);
        const initial = sourcePosition();
        active = { id: source.id, data: source.data, rect: { current: { initial, translated: initial } } };
        // Some surfaces mount their empty drop zone on pickup. Measure the committed layout before resolving the first target.
        flushSync(() => notify('onDragStart'));
        update(delta, pointerCoordinates);
      },
      move(nextDelta, point) { if (active) update(nextDelta, point); },
      scroll() { if (active && pointer) update(delta, pointer); },
      step(key, getter) {
        if (!active || !getter) return;
        const rect = active.rect.current.translated;
        const point = getter(key, { active, currentCoordinates: { x: rect.left, y: rect.top }, context: {
          active, over, collisionRect: rect, droppableRects, droppableContainers: { getEnabled: () => enabled },
        } });
        if (!point) return;
        update({ x: point.x - active.rect.current.initial.left, y: point.y - active.rect.current.initial.top }, null);
        const node = over && registry.get(over.id)?.node.current;
        if (node?.scrollIntoView) {
          const before = over.rect;
          node.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
          const after = measured.get(node)();
          if (before.left !== after.left || before.top !== after.top) {
            update({ x: delta.x + after.left - before.left, y: delta.y + after.top - before.top }, null);
          }
        }
      },
      finish(started, cancelled) {
        tracking.current = null;
        if (!started || !active) return;
        if (over && (!registry.get(over.id)?.node.current || registry.get(over.id)?.disabled)) over = null;
        notify(cancelled || source.disabled.current || !source.node.current ? 'onDragCancel' : 'onDragEnd');
        setView(null);
        if (kind === 'keyboard' && handle.isConnected && handle.ownerDocument.activeElement === handle.ownerDocument.body) handle.focus();
      },
    };
    session.dispose = attachSensor(kind, options, event, handle, actions);
  }, [registry]);

  return <DragState.Provider value={{ registry, sensors, begin, view, instructions }}>
    {children}
    <span id={instructions} hidden>{accessibility?.screenReaderInstructions?.draggable ?? 'Press Space or Enter to pick up, use the arrow keys to move, then Space or Enter to drop or Escape to cancel.'}</span>
    <div data-dnd-announcement className="sr-only" role="status" aria-live="assertive" aria-atomic="true">{message}</div>
  </DragState.Provider>;
}

export function DragOverlay({ children }) {
  const view = useContext(DragState)?.view;
  if (!view || !children) return null;
  const { left, top, width, height } = view.active.rect.current.initial;
  const style = { position: 'fixed', left, top, width, height, pointerEvents: 'none', zIndex: 999,
    transform: `translate3d(${view.delta.x}px, ${view.delta.y}px, 0)` };
  return createPortal(<div aria-hidden="true" style={style}>{children}</div>, document.body);
}
