import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
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

describe('RenderTab batch count', () => {
  it('explains invalid edits and disables every render target until corrected', () => {
    const handleRender = vi.fn();
    const props = {
      ...baseProps,
      availableBackends: [{ id: 'local' }],
      bucketsByKind: { characters: ['heroes'], other: ['concepts'] },
      draft: {
        ...baseProps.draft,
        characters: [{ name: 'Hero', description: 'An example hero' }],
        categories: {
          heroes: { variations: [{ label: 'Scout' }] },
          concepts: { variations: [{ label: 'Color Study' }] },
        },
        compositeSheets: [{ label: 'Example board' }],
      },
      handleRender,
      runs: [],
    };
    function RenderTabHarness() {
      const [renderOpts, setRenderOpts] = useState({ batchPerVariation: 1 });
      return <RenderTab {...props} renderOpts={renderOpts} setRenderOpts={setRenderOpts} />;
    }

    render(<MemoryRouter><RenderTabHarness /></MemoryRouter>);
    const input = screen.getByRole('spinbutton', { name: 'Renders per prompt' });
    for (const value of ['21', '1.5', '']) {
      fireEvent.change(input, { target: { value } });
      expect(input.getAttribute('aria-invalid')).toBe('true');
      expect(screen.getByRole('alert').textContent).toBe('Enter a whole number from 1 to 20.');
      expect(screen.getAllByRole('button').length).toBeGreaterThan(1);
      for (const button of screen.getAllByRole('button')) {
        expect(button.disabled).toBe(true);
        fireEvent.click(button);
      }
    }
    expect(handleRender).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { value: '20' } });
    expect(screen.queryByRole('alert')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Render everything (80 images)' }));
    expect(handleRender).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ promptMode: 'all' }));
  });
});
