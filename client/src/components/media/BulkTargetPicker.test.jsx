import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, act, within } from '@testing-library/react';
import BulkTargetPicker from './BulkTargetPicker.jsx';

vi.mock('../../services/apiImageVideo.js', () => ({
  listMediaCollections: vi.fn(),
  createMediaCollection: vi.fn(),
}));

describe('BulkTargetPicker', () => {
  it('renders ListLoadError with retry on failed collections load', async () => {
    const onRetry = vi.fn();
    render(
      <BulkTargetPicker
        anchorRef={{ current: document.createElement('button') }}
        excludeId="col-1"
        collections={null}
        error={new Error('500 Server Error')}
        onRetry={onRetry}
        onPick={vi.fn()}
        onClose={vi.fn()}
      />
    );
    await act(async () => {});

    expect(screen.getByRole('alert')).toHaveTextContent('Could not load collections — 500 Server Error');
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(screen.queryByText('No collections yet — create one below.')).not.toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    });
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('renders empty message on real empty collections', () => {
    render(
      <BulkTargetPicker
        anchorRef={{ current: document.createElement('button') }}
        excludeId="col-1"
        collections={[]}
        onPick={vi.fn()}
        onClose={vi.fn()}
      />
    );

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByText('No collections yet — create one below.')).toBeInTheDocument();
  });

  it('alphabetizes move destinations and excludes the current collection', () => {
    const onPick = vi.fn();
    render(
      <BulkTargetPicker
        anchorRef={{ current: document.createElement('button') }}
        excludeId="col-1"
        title="Move to…"
        collections={[
          { id: 'col-1', name: 'Current', items: [] },
          { id: 'col-2', name: 'Landscapes', items: [{ kind: 'image', ref: 'a.jpg' }] },
          { id: 'col-3', name: 'Universe: architecture', source: 'auto', items: [] },
        ]}
        onPick={onPick}
        onClose={vi.fn()}
      />
    );

    const rows = within(screen.getByRole('list')).getAllByRole('button');
    expect(rows.map((row) => row.textContent)).toEqual(['Universearchitecture0', 'Landscapes1']);
    fireEvent.click(rows[0]);
    expect(onPick).toHaveBeenCalledWith('col-3', 'Universe: architecture');
    expect(screen.queryByText('No collections yet — create one below.')).not.toBeInTheDocument();
  });
});
