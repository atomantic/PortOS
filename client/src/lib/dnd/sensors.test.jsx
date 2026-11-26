import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DndContext, DragOverlay, KeyboardSensor, MouseSensor, PointerSensor, TouchSensor, closestCenter, useDraggable, useDroppable, useSensor, useSensors } from './index.js';
import { createFreeDroppableKeyboardCoordinates } from '../dndKeyboardCoordinates.js';

function Items({ disabled, targetDisabled }) {
  const drag = useDraggable({ id: 'source', data: { title: 'Source' }, disabled });
  const target = useDroppable({ id: 'target', data: { title: 'Destination' }, disabled: targetDisabled });
  return <>
    <button ref={drag.setNodeRef} {...drag.attributes} {...drag.listeners}>Lift</button>
    <div ref={target.setNodeRef}>Target</div>
    <DragOverlay>{drag.isDragging && 'Preview'}</DragOverlay>
  </>;
}

function Board({ sensor, disabled, targetDisabled, ...callbacks }) {
  const sensors = useSensors(useSensor(sensor, { activationConstraint: sensor === TouchSensor ? { delay: 250, tolerance: 5 } : { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: createFreeDroppableKeyboardCoordinates() }));
  return <DndContext sensors={sensors} accessibility={{ screenReaderInstructions: { draggable: 'Lift with Space' } }} collisionDetection={closestCenter} {...callbacks}>
    <Items disabled={disabled} targetDisabled={targetDisabled} />
  </DndContext>;
}

afterEach(() => vi.useRealTimers());

describe('drag input and lifecycle', () => {
  it.each([['pointer', PointerSensor], ['mouse', MouseSensor]])('requires movement for a %s drag and positions the preview in a portal', (kind, sensor) => {
    const start = vi.fn(), end = vi.fn();
    const { container } = render(<Board sensor={sensor} onDragStart={start} onDragEnd={end} />);
    const handle = screen.getByRole('button');
    const dispatch = (suffix, target, x) => fireEvent[kind + suffix](target, { button: 0, clientX: x, clientY: 10, pointerId: 1, isPrimary: true });
    dispatch('Down', handle, 10);
    dispatch('Move', document, 16);
    dispatch('Up', document, 16);
    expect(start).not.toHaveBeenCalled();
    dispatch('Down', handle, 10);
    dispatch('Move', document, 25);
    expect(start).toHaveBeenCalledTimes(1);
    expect(container.contains(screen.getByText('Preview'))).toBe(false);
    expect(screen.getByText('Preview').style.transform).toContain('15px');
    dispatch('Up', document, 25);
    expect(end.mock.calls[0][0]).toMatchObject({ active: { id: 'source', data: { current: { title: 'Source' } } }, over: { id: 'target', data: { current: { title: 'Destination' } } } });
    expect(screen.queryByText('Preview')).toBeNull();
  });

  it('lets a touch swipe scroll, activates a stationary long press, and cancels on interruption', () => {
    vi.useFakeTimers();
    const start = vi.fn(), cancel = vi.fn();
    render(<Board sensor={TouchSensor} onDragStart={start} onDragCancel={cancel} />);
    const touch = x => ({ identifier: 1, clientX: x, clientY: 0 });
    const handle = screen.getByRole('button');
    fireEvent.touchStart(handle, { touches: [touch(0)] });
    fireEvent.touchMove(document, { touches: [touch(9)] });
    act(() => vi.advanceTimersByTime(250));
    expect(start).not.toHaveBeenCalled();
    fireEvent.touchStart(handle, { touches: [touch(0)] });
    fireEvent.touchMove(document, { touches: [touch(3)] });
    act(() => vi.advanceTimersByTime(250));
    expect(start).toHaveBeenCalledTimes(1);
    fireEvent.touchCancel(document, { changedTouches: [touch(3)] });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('excludes disabled targets, including one disabled between the last move and release', () => {
    const end = vi.fn();
    const { rerender } = render(<Board sensor={PointerSensor} onDragEnd={end} />);
    const handle = screen.getByRole('button');
    const key = code => fireEvent.keyDown(handle, { code });
    key('Space');
    rerender(<Board sensor={PointerSensor} targetDisabled onDragEnd={end} />);
    key('Enter');
    key('Space');
    key('Enter');
    expect(end.mock.calls.map(([detail]) => detail.over)).toEqual([null, null]);
  });

  it('disarms a pending long press when the board unmounts', () => {
    vi.useFakeTimers();
    const start = vi.fn();
    const { unmount } = render(<Board sensor={TouchSensor} onDragStart={start} />);
    fireEvent.touchStart(screen.getByRole('button'), { touches: [{ identifier: 1, clientX: 0, clientY: 0 }] });
    unmount();
    act(() => vi.advanceTimersByTime(260));
    expect(start).not.toHaveBeenCalled();
  });

  it('supports pickup, immediate keyboard steps, drop, cancel and disabled handles', () => {
    const end = vi.fn(), cancel = vi.fn();
    const { rerender } = render(<Board sensor={PointerSensor} onDragEnd={end} onDragCancel={cancel} />);
    const handle = screen.getByRole('button');
    expect(handle).toHaveAccessibleDescription('Lift with Space');
    const key = code => fireEvent.keyDown(handle, { code, key: code === 'Space' ? ' ' : code });
    key('Space');
    key('ArrowDown');
    expect(screen.getByRole('status')).toHaveTextContent(/target/);
    key('Enter');
    expect(end.mock.calls[0][0].over.id).toBe('target');
    key('Enter');
    key('Escape');
    expect(cancel).toHaveBeenCalledOnce();
    expect(screen.getByRole('status')).toHaveTextContent(/cancel/i);
    rerender(<Board sensor={PointerSensor} disabled onDragEnd={end} />);
    key('Space');
    expect(screen.queryByText('Preview')).toBeNull();
  });
});
