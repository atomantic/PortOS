import { act, render } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';

const dndState = vi.hoisted(() => ({ context: null }));
const api = vi.hoisted(() => ({
  getJiraBoardColumns: vi.fn(),
  createJiraTicketTask: vi.fn(),
  getJiraTicketTransitions: vi.fn(),
  transitionJiraTicket: vi.fn(),
}));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));

vi.mock('../services/api', () => api);
vi.mock('./ui/Toast', () => ({ default: toast }));
vi.mock('@dnd-kit/core', () => ({
  DndContext: ({ children, ...props }) => {
    dndState.context = props;
    return <>{children}</>;
  },
  DragOverlay: ({ children }) => <>{children}</>,
  closestCenter: vi.fn(() => []),
  KeyboardSensor: function KeyboardSensorStub() {},
  PointerSensor: function PointerSensorStub() {},
  useDraggable: () => ({
    attributes: {},
    listeners: {},
    setNodeRef: () => {},
    setActivatorNodeRef: () => {},
    transform: null,
    isDragging: false,
  }),
  useDroppable: () => ({ setNodeRef: () => {} }),
  useSensor: (sensor, options) => ({ sensor, options }),
  useSensors: (...sensors) => sensors,
}));

import { closestCenter, KeyboardSensor } from '@dnd-kit/core';
import KanbanBoard, { kanbanCollisionDetection, kanbanKeyboardCoordinates } from './KanbanBoard';

const TICKETS = [
  { key: 'PORT-1', summary: 'First ticket', status: 'Backlog', statusCategory: 'To Do', issueType: 'Task', url: 'https://jira.example/PORT-1' },
  { key: 'PORT-2', summary: 'Second ticket', status: 'Selected', statusCategory: 'To Do', issueType: 'Task', url: 'https://jira.example/PORT-2' },
  { key: 'PORT-3', summary: 'Working ticket', status: 'In Progress', statusCategory: 'In Progress', issueType: 'Task', url: 'https://jira.example/PORT-3' },
];

const ticketData = (ticket, columnId, columnIndex, position) => ({
  type: 'ticket',
  ticketKey: ticket.key,
  columnId,
  columnName: columnId === 'col-0' ? 'To Do' : columnId === 'col-1' ? 'In Progress' : 'Done',
  columnIndex,
  position,
});

const makeEntry = (id, data, rect, disabled = false) => ({
  id,
  data: { current: data },
  rect,
  disabled,
});

function renderBoard(props = {}) {
  return render(<KanbanBoard tickets={TICKETS} instanceId="jira-1" {...props} />);
}

beforeEach(() => {
  vi.clearAllMocks();
  dndState.context = null;
  api.getJiraBoardColumns.mockResolvedValue({ columns: [] });
  api.getJiraTicketTransitions.mockResolvedValue([]);
  api.transitionJiraTicket.mockResolvedValue({});
});

describe('KanbanBoard keyboard drag and drop', () => {
  it('registers a keyboard sensor with column-aware collision and accessibility contracts', () => {
    renderBoard();

    const keyboardSensor = dndState.context.sensors.find(({ sensor }) => sensor === KeyboardSensor);
    expect(keyboardSensor).toBeDefined();
    expect(keyboardSensor.options).toEqual({ coordinateGetter: kanbanKeyboardCoordinates });
    expect(dndState.context.collisionDetection).toBe(kanbanCollisionDetection);

    const active = { id: 'PORT-1', data: { current: { ticket: TICKETS[0], columnName: 'To Do' } } };
    const over = { id: 'ticket:PORT-3', data: { current: ticketData(TICKETS[2], 'col-1', 1, 0) } };
    const { announcements, screenReaderInstructions } = dndState.context.accessibility;

    expect(announcements.onDragStart({ active })).toMatch(/Picked up ticket PORT-1 from To Do/);
    expect(announcements.onDragOver({ active, over })).toMatch(/PORT-1 moved over In Progress, position 1/);
    expect(announcements.onDragEnd({ active, over })).toMatch(/Dropped ticket PORT-1 in In Progress, position 1/);
    expect(announcements.onDragCancel({ active })).toMatch(/Cancelled dragging ticket PORT-1/);
    expect(screenReaderInstructions.draggable).toMatch(/Space or Enter/);
    expect(screenReaderInstructions.draggable).toMatch(/arrow keys/);
    expect(screenReaderInstructions.draggable).toMatch(/Escape to cancel/);
  });

  it('moves to adjacent ticket slots vertically and preserves the slot horizontally', () => {
    const rects = new Map([
      ['col-0', { left: 0, top: 0, width: 220, height: 300 }],
      ['col-1', { left: 240, top: 0, width: 220, height: 300 }],
      ['col-2', { left: 480, top: 0, width: 220, height: 300 }],
      ['ticket:PORT-1', { left: 12, top: 48, width: 196, height: 60 }],
      ['ticket:PORT-2', { left: 12, top: 120, width: 196, height: 60 }],
      ['ticket:PORT-3', { left: 252, top: 48, width: 196, height: 60 }],
    ]);
    const entries = [
      makeEntry('col-0', { type: 'column', columnId: 'col-0', columnIndex: 0 }, rects.get('col-0')),
      makeEntry('ticket:PORT-1', ticketData(TICKETS[0], 'col-0', 0, 0), rects.get('ticket:PORT-1')),
      makeEntry('ticket:PORT-2', ticketData(TICKETS[1], 'col-0', 0, 1), rects.get('ticket:PORT-2')),
      makeEntry('col-1', { type: 'column', columnId: 'col-1', columnIndex: 1 }, rects.get('col-1')),
      makeEntry('ticket:PORT-3', ticketData(TICKETS[2], 'col-1', 1, 0), rects.get('ticket:PORT-3')),
      makeEntry('col-2', { type: 'column', columnId: 'col-2', columnIndex: 2 }, rects.get('col-2')),
    ];
    const active = 'PORT-1';
    const context = {
      active: { id: active, data: { current: { columnId: 'col-0', columnIndex: 0, position: 0 } } },
      droppableRects: rects,
      droppableContainers: { getEnabled: () => entries },
      over: { id: 'ticket:PORT-1', data: { current: ticketData(TICKETS[0], 'col-0', 0, 0) } },
    };

    const downEvent = { code: 'ArrowDown', preventDefault: vi.fn() };
    expect(kanbanKeyboardCoordinates(downEvent, { active, context })).toEqual({ x: 12, y: 120 });
    expect(downEvent.preventDefault).not.toHaveBeenCalled();

    context.over = { id: 'ticket:PORT-2', data: { current: ticketData(TICKETS[1], 'col-0', 0, 1) } };
    const rightEvent = { code: 'ArrowRight', preventDefault: vi.fn() };
    expect(kanbanKeyboardCoordinates(rightEvent, { active, context })).toEqual({ x: 252, y: 48 });

    context.over = { id: 'ticket:PORT-3', data: { current: ticketData(TICKETS[2], 'col-1', 1, 0) } };
    const rightToEmptyColumn = { code: 'ArrowRight', preventDefault: vi.fn() };
    expect(kanbanKeyboardCoordinates(rightToEmptyColumn, { active, context })).toEqual({ x: 480, y: 0 });
  });

  it('excludes the active ticket slot from collision candidates', () => {
    const activeDrop = { id: 'ticket:PORT-1' };
    const otherDrop = { id: 'ticket:PORT-2' };
    const columnDrop = { id: 'col-0' };
    const args = {
      active: { id: 'PORT-1' },
      collisionRect: {},
      droppableRects: new Map(),
      droppableContainers: [activeDrop, otherDrop, columnDrop],
      pointerCoordinates: null,
    };

    kanbanCollisionDetection(args);

    expect(args.droppableContainers).toEqual([activeDrop, otherDrop, columnDrop]);
    expect(closestCenter).toHaveBeenCalledWith(expect.objectContaining({
      droppableContainers: [otherDrop, columnDrop],
    }));
  });

  it('resolves a card-slot drop to its destination column and transitions the ticket', async () => {
    const onTicketsChange = vi.fn();
    api.getJiraTicketTransitions.mockResolvedValue([
      { id: 'transition-1', to: 'In Progress', toCategory: 'In Progress' },
    ]);
    renderBoard({ onTicketsChange });

    await act(async () => {
      await dndState.context.onDragEnd({
        active: { id: 'PORT-1', data: { current: { ticket: TICKETS[0] } } },
        over: { id: 'ticket:PORT-3', data: { current: ticketData(TICKETS[2], 'col-1', 1, 0) } },
      });
    });

    expect(api.getJiraTicketTransitions).toHaveBeenCalledWith('jira-1', 'PORT-1', { silent: true });
    expect(api.transitionJiraTicket).toHaveBeenCalledWith('jira-1', 'PORT-1', 'transition-1', { silent: true });
    const finalTickets = onTicketsChange.mock.calls.at(-1)[0];
    expect(finalTickets.find(ticket => ticket.key === 'PORT-1')).toMatchObject({
      status: 'In Progress',
      statusCategory: 'In Progress',
    });
  });
});
