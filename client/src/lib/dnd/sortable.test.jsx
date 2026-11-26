import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { arrayMove, closestCenter, DndContext, horizontalListSortingStrategy, KeyboardSensor, rectSortingStrategy, SortableContext, sortableKeyboardCoordinates, useSensor, useSensors, useSortable, verticalListSortingStrategy } from './index.js';
import { dndTransformToCss } from '../dndTransform.js';

function Item({ id }) {
  const { attributes, listeners, setNodeRef, transform } = useSortable({ id });
  return <button ref={setNodeRef} {...attributes} {...listeners} style={{ transform: dndTransformToCss(transform) }}>{id}</button>;
}

function List({ strategy, end }) {
  const sensors = useSensors(useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));
  return <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={end}>
    <SortableContext items={['a', 'b', 'c']} strategy={strategy}>
      {['a', 'b', 'c'].map(id => <Item key={id} id={id} />)}
    </SortableContext>
  </DndContext>;
}

describe('sortable layout', () => {
  it.each([
    [verticalListSortingStrategy, 'ArrowDown', [[0, 0], [0, 30], [0, 60]], 'translate3d(0px, -30px, 0)'],
    [horizontalListSortingStrategy, 'ArrowRight', [[0, 0], [30, 0], [60, 0]], 'translate3d(-30px, 0px, 0)'],
    [rectSortingStrategy, 'ArrowDown', [[0, 0], [30, 0], [0, 30]], 'translate3d(30px, -30px, 0)'],
  ])('moves displaced siblings into the vacated space', (strategy, code, positions, translation) => {
    const end = vi.fn();
    render(<List strategy={strategy} end={end} />);
    const nodes = screen.getAllByRole('button');
    for (const [index, [left, top]] of positions.entries()) {
      nodes[index].getBoundingClientRect = () => ({ left, top, width: 20, height: 20, bottom: top + 20, right: left + 20 });
    }
    act(() => nodes[0].focus());
    fireEvent.keyDown(nodes[0], { code: 'Space' });
    fireEvent.keyDown(nodes[0], { code });
    const target = code === 'ArrowDown' && strategy === rectSortingStrategy ? 2 : 1;
    expect(nodes[target].style.transform).toContain(translation);
    fireEvent.keyDown(nodes[0], { code: 'Space' });
    expect(end.mock.calls[0][0].over.id).toBe(nodes[target].textContent);
  });

  it('moves to the requested index without mutating the list', () => {
    const items = Object.freeze(['a', 'b', 'c']);
    expect(arrayMove(items, 0, -1)).toEqual(['b', 'c', 'a']);
    expect(arrayMove(items, 2, 0)).toEqual(['c', 'a', 'b']);
  });
});
