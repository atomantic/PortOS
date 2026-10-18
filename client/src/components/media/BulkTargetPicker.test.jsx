import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import BulkTargetPicker from './BulkTargetPicker.jsx';

vi.mock('../../services/api', () => ({
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

  it('renders collection choices when collections are loaded', () => {
    render(
      <BulkTargetPicker
        anchorRef={{ current: document.createElement('button') }}
        excludeId="col-1"
        collections={[
          { id: 'col-2', name: 'Landscapes', items: [{ kind: 'image', ref: 'a.jpg' }] },
        ]}
        onPick={vi.fn()}
        onClose={vi.fn()}
      />
    );

    expect(screen.getByText('Landscapes')).toBeInTheDocument();
    expect(screen.queryByText('No collections yet — create one below.')).not.toBeInTheDocument();
  });
});
