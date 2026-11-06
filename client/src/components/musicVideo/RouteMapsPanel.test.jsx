import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import RealRouteMapsPanel from './RouteMapsPanel.jsx';

const greyboxPlaces = vi.hoisted(() => ({ current: {} }));
vi.mock('../../hooks/useMusicVideoGreyboxPlaces.js', () => ({ default: () => greyboxPlaces.current }));

const RouteMapsPanel = (props) => <MemoryRouter><RealRouteMapsPanel {...props} /></MemoryRouter>;

const places = [
  { id: 'p-curve', kind: 'place', name: 'Curving street', ingredientId: 'cat-plc-1' },
  { id: 'p-brick', kind: 'place', name: 'Straight block' },
];
const boardFor = (over = {}) => ({
  project: {
    id: 'p',
    concept: { subjects: places },
    scenes: [
      { sceneId: 'a', order: 0, setReference: { subjectId: 'p-curve' } },
      { sceneId: 'b', order: 1, setReference: { subjectId: 'p-curve' } },
      { sceneId: 'c', order: 2, setReference: { subjectId: 'p-brick' } },
    ],
    ...over,
  },
  locked: false, editProjectLocal: vi.fn(), saveProjectFields: vi.fn(),
});

describe('RouteMapsPanel', () => {
  // Catches the one-tap route request not reading the places off the shots, or not saving them.
  it('drafts a route from the places the shots visit and saves it', () => {
    const board = boardFor();
    render(<RouteMapsPanel board={board} />);
    fireEvent.click(screen.getByText('Route maps'));
    fireEvent.click(screen.getByRole('button', { name: /Draft route with 2 places/ }));
    const [{ routeMaps }] = board.saveProjectFields.mock.calls[0];
    expect(routeMaps).toHaveLength(1);
    expect(routeMaps[0].stops.map((stop) => stop.subjectId)).toEqual(['p-curve', 'p-brick']);
    expect(board.editProjectLocal).toHaveBeenCalledWith({ routeMaps });
  });

  // Catches the drawn route losing each stop's shots or its link to the catalog environment.
  it('draws each stop with its shots and environment link, and saves a new direction of travel', () => {
    const routeMaps = [{ id: 'r', name: 'Opening ride', heading: null, travel: '', stops: [{ id: 'a', subjectId: 'p-curve' }, { id: 'b', subjectId: 'p-brick' }] }];
    const board = boardFor({ routeMaps });
    render(<RouteMapsPanel board={board} />);
    fireEvent.click(screen.getByText('Route maps'));
    expect(screen.getByText('1 route · 2 stops')).toBeInTheDocument();
    expect(screen.getByText(/Shots 1-2/)).toBeInTheDocument();
    expect(screen.getByText(/Shot 3/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Environment' })).toHaveAttribute('href', '/environments/cat-plc-1');
    fireEvent.change(screen.getByLabelText('Opening ride direction of travel'), { target: { value: 'west' } });
    expect(board.saveProjectFields).toHaveBeenCalledWith({ routeMaps: [{ ...routeMaps[0], heading: 'west' }] });
  });

  // Catches a stretch's side streets or look-back camera not reaching the saved stop.
  it('adds a side street on the left and picks the place camera that looks back', () => {
    greyboxPlaces.current = { 'cat-plc-1': { ingredient: { id: 'cat-plc-1', type: 'place', payload: { greybox: { shots: [{ id: 'ahead', label: 'Up the street' }, { id: 'behind', label: 'Down the street' }] } } }, media: [] } };
    const routeMaps = [{ id: 'r', name: 'Opening ride', stops: [{ id: 'a', subjectId: 'p-curve' }, { id: 'b', subjectId: 'p-brick' }] }];
    const board = boardFor({ routeMaps });
    render(<RouteMapsPanel board={board} />);
    fireEvent.click(screen.getByText('Route maps'));
    fireEvent.click(screen.getAllByRole('button', { name: 'Side street' })[0]);
    const [{ routeMaps: withStreet }] = board.saveProjectFields.mock.calls.at(-1);
    expect(withStreet[0].stops[0].features).toEqual([expect.objectContaining({ kind: 'side-street', side: 'left' })]);
    fireEvent.change(screen.getByLabelText('Stop 1 looking back camera'), { target: { value: 'behind' } });
    expect(board.saveProjectFields.mock.calls.at(-1)[0].routeMaps[0].stops[0].views).toEqual({ back: 'behind' });
    greyboxPlaces.current = {};
  });
});
