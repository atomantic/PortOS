import { render, screen, within } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import LoomReferenceReview from './LoomReferenceReview';
vi.mock('../MediaImage', () => ({ default: (props) => <img {...props} /> }));

it('compares graph predecessors rather than array neighbors and includes each converging path', async () => {
  const current = { id: 'current', title: 'Meeting', image: 'meeting.png', shot: { framing: 'Reverse close-up', durationSeconds: 8 }, visualCanon: { continuitySourceNodeId: 'left', shotNotes: 'Keep the window behind the desk.' } };
  const episode = { nodes: [
    { id: 'unrelated', title: 'Elsewhere', image: 'elsewhere.png' },
    current,
    { id: 'right', title: 'Right path', image: 'right.png', transitions: [{ targetNodeId: 'current' }] },
    { id: 'left', title: 'Left path', image: 'left.png', transitions: [{ targetNodeId: 'current' }] },
  ] };
  const onSelectNode = vi.fn();
  render(<LoomReferenceReview episode={episode} node={current} onSelectNode={onSelectNode} />);
  expect(screen.queryByText(/Elsewhere/)).not.toBeInTheDocument();
  expect(screen.getByText(/2 incoming paths/)).toBeInTheDocument();
  expect(screen.getByAltText('Previous · chosen continuity source: Left path')).toHaveAttribute('src', '/data/images/left.png');
  expect(screen.getAllByAltText('Current: Meeting')).toHaveLength(2);
  expect(screen.getAllByText('Reverse close-up · 8s')).toHaveLength(2);
  expect(screen.getAllByText('Continuity: Keep the window behind the desk.')).toHaveLength(2);
  await userEvent.click(screen.getByRole('button', { name: 'Edit reference shot: Left path' }));
  expect(onSelectNode).toHaveBeenCalledWith('left');
});

it('shows missing images explicitly and an opening without a fabricated previous shot', () => {
  const opening = { id: 'opening', title: 'Arrival' };
  render(<LoomReferenceReview episode={{ startNodeId: opening.id, nodes: [opening] }} node={opening} />);
  expect(screen.getByText('Opening shot — establishes the visual setting.')).toBeInTheDocument();
  expect(screen.getByText('No reference image yet')).toBeInTheDocument();
  expect(within(screen.getByRole('region')).queryByRole('link')).not.toBeInTheDocument();
});
