import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import RenderTab from './RenderTab';

vi.mock('../imageGen/ImageGenSettingsForm', () => ({ default: () => null }));
vi.mock('../imageGen/RecordRenderPinRow', () => ({ default: () => null }));

const baseProps = {
  draft: { categories: {}, compositeSheets: [], characters: [], places: [], objects: [] },
  setRenderPin: vi.fn(),
  selectedId: 'u1',
  bucketsByKind: {},
  renderOpts: {},
  setRenderOpts: vi.fn(),
  availableBackends: [],
  defaultMode: 'local',
  imageModels: [],
  handleRender: vi.fn(),
  rendering: false,
};

const renderTab = (props) => render(
  <MemoryRouter><RenderTab {...baseProps} {...props} /></MemoryRouter>,
);

describe('RenderTab run history', () => {
  it('shows a persistent error with Retry when history failed to load', () => {
    const onRetryRuns = vi.fn();
    renderTab({ runs: [], runsStatus: 'error', onRetryRuns });
    expect(screen.getByRole('alert').textContent).toMatch(/Could not load run history/);
    expect(screen.queryByText('No renders yet.')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetryRuns).toHaveBeenCalledTimes(1);
  });

  it('keeps last-known rows beside a stale notice on a failed refresh', () => {
    renderTab({
      runs: [{ id: 'r1', createdAt: '2026-01-01T00:00:00.000Z', promptCount: 2, collectionId: 'c1' }],
      runsStatus: 'error',
      onRetryRuns: vi.fn(),
    });
    expect(screen.getByRole('alert').textContent).toMatch(/last loaded runs/);
    expect(screen.getByText('Open collection →')).toBeTruthy();
  });

  it('shows a distinct empty state for a successful empty history', () => {
    renderTab({ runs: [], runsStatus: 'ready', onRetryRuns: vi.fn() });
    expect(screen.getByText('No renders yet.')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
