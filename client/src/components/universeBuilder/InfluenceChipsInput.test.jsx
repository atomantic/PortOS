import { describe, it, expect, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// `vi.hoisted` so the mock-state lives before the `vi.mock` factories below
// (Vitest hoists `vi.mock` calls to the top of the file). NOTE: this is
// module-scoped — if a single test ever renders two `<InfluenceChipsInput>`
// instances, the last-rendered DndContext wins (later renders overwrite
// `onDragEnd`). Add a per-render scope if that ever bites.
const dndState = vi.hoisted(() => ({ onDragEnd: null }));

// Stub @dnd-kit/core's DndContext so we can fire drag-end events imperatively
// from the test. The real implementation needs DOM measurement + pointer
// sensors, which jsdom doesn't provide reliably — but the only behavior we
// care about here is "what does the component do when onDragEnd fires with
// these ids," and that's all driven through the `onDragEnd` callback we
// capture below.
vi.mock('@dnd-kit/core', () => ({
  DndContext: ({ children, onDragEnd }) => {
    dndState.onDragEnd = onDragEnd;
    return <>{children}</>;
  },
  KeyboardSensor: function KeyboardSensorStub() {},
  PointerSensor: function PointerSensorStub() {},
  closestCenter: () => null,
  useSensor: () => null,
  useSensors: () => [],
}));

// Keep `arrayMove` real (we want the live ordering invariant) but stub
// `useSortable` so each chip renders without DnD lifecycle wiring.
vi.mock('@dnd-kit/sortable', async () => {
  const actual = await vi.importActual('@dnd-kit/sortable');
  return {
    ...actual,
    SortableContext: ({ children }) => <>{children}</>,
    useSortable: () => ({
      attributes: {},
      listeners: {},
      setNodeRef: () => {},
      transform: null,
      transition: null,
      isDragging: false,
    }),
    rectSortingStrategy: 'rect',
    sortableKeyboardCoordinates: () => null,
  };
});

// Imported after the mocks so the component picks them up.
import InfluenceChipsInput from './InfluenceChipsInput';

const fireDragEnd = (activeId, overId) => act(() => {
  dndState.onDragEnd({ active: { id: activeId }, over: overId == null ? null : { id: overId } });
});

describe('InfluenceChipsInput — chip-reorder smoke tests', () => {
  it('renders the token chips in order', () => {
    render(<InfluenceChipsInput tokens={['alpha', 'bravo', 'charlie']} onChange={() => {}} />);
    // Assert DOM order via the per-chip drag-handle aria-labels — they share
    // a parent ordering with the visible chip text and are uniquely scoped
    // to each chip, so we don't pick up the label-via-token side text.
    const handles = screen.getAllByLabelText(/Drag (alpha|bravo|charlie) to reorder/);
    expect(handles.map((h) => h.getAttribute('aria-label'))).toEqual([
      'Drag alpha to reorder',
      'Drag bravo to reorder',
      'Drag charlie to reorder',
    ]);
  });

  it('calls onChange with the reordered tokens when a chip moves forward', () => {
    const onChange = vi.fn();
    render(<InfluenceChipsInput tokens={['alpha', 'bravo', 'charlie']} onChange={onChange} />);

    // Drag `charlie` over `alpha` → ['charlie', 'alpha', 'bravo']
    fireDragEnd('charlie', 'alpha');

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(['charlie', 'alpha', 'bravo']);
  });

  it('calls onChange with the reordered tokens when a chip moves backward', () => {
    const onChange = vi.fn();
    render(<InfluenceChipsInput tokens={['alpha', 'bravo', 'charlie']} onChange={onChange} />);

    // Drag `alpha` over `charlie` → ['bravo', 'charlie', 'alpha']
    fireDragEnd('alpha', 'charlie');

    expect(onChange).toHaveBeenCalledWith(['bravo', 'charlie', 'alpha']);
  });

  it('does not call onChange when dropped on the same chip (no-op drag)', () => {
    const onChange = vi.fn();
    render(<InfluenceChipsInput tokens={['alpha', 'bravo', 'charlie']} onChange={onChange} />);

    fireDragEnd('bravo', 'bravo');

    expect(onChange).not.toHaveBeenCalled();
  });

  it('does not call onChange when dropped outside any chip (over is null)', () => {
    const onChange = vi.fn();
    render(<InfluenceChipsInput tokens={['alpha', 'bravo', 'charlie']} onChange={onChange} />);

    fireDragEnd('alpha', null);

    expect(onChange).not.toHaveBeenCalled();
  });

  it('does not call onChange when active id is not in the list (stale drag)', () => {
    const onChange = vi.fn();
    render(<InfluenceChipsInput tokens={['alpha', 'bravo', 'charlie']} onChange={onChange} />);

    fireDragEnd('ghost', 'bravo');

    expect(onChange).not.toHaveBeenCalled();
  });

  it('does not call onChange when over id is not in the list (stale target)', () => {
    const onChange = vi.fn();
    render(<InfluenceChipsInput tokens={['alpha', 'bravo', 'charlie']} onChange={onChange} />);

    fireDragEnd('alpha', 'ghost');

    expect(onChange).not.toHaveBeenCalled();
  });

  it('removes a chip via the X button', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<InfluenceChipsInput tokens={['alpha', 'bravo', 'charlie']} onChange={onChange} />);

    await user.click(screen.getByLabelText('Remove bravo'));

    expect(onChange).toHaveBeenCalledWith(['alpha', 'charlie']);
  });

  it('readOnly mode renders chips without DnD wiring', () => {
    const onChange = vi.fn();
    render(<InfluenceChipsInput tokens={['alpha', 'bravo']} onChange={onChange} readOnly />);

    expect(screen.getByText('alpha')).toBeInTheDocument();
    expect(screen.getByText('bravo')).toBeInTheDocument();
    // No drag handles, no remove buttons, no input in readOnly mode.
    expect(screen.queryByLabelText(/Drag alpha to reorder/)).toBeNull();
    expect(screen.queryByLabelText(/Remove alpha/)).toBeNull();
  });
});
