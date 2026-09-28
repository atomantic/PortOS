/**
 * Production panel (#9066) over the real useMusicVideoProduction hook with a
 * mocked API and socket: a run starts only with the director's explicit pool
 * and limits, a restart-interrupted run is resumed explicitly, and a pushed
 * project updates the visible run.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useState } from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';

const listeners = vi.hoisted(() => new Map());
vi.mock('../../services/socket', () => ({
  default: { on: (ev, fn) => listeners.set(ev, fn), off: (ev) => listeners.delete(ev) },
}));
vi.mock('../../services/apiMusicVideo.js', () => ({
  startMusicVideoProduction: vi.fn(),
  resumeMusicVideoProduction: vi.fn(),
  stopMusicVideoProduction: vi.fn(),
  cancelMusicVideoProduction: vi.fn(),
}));
vi.mock('../ui/Toast', () => ({ default: { success: vi.fn(), info: vi.fn(), error: vi.fn() } }));
vi.mock('../../hooks/useProviderModels.js', () => ({
  default: () => ({
    providers: [], selectedProviderId: '', selectedModel: '', availableModels: [],
    setSelectedProviderId: () => {}, setSelectedModel: () => {},
  }),
}));

import ProductionPanel from './ProductionPanel.jsx';
import useMusicVideoProduction from '../../hooks/useMusicVideoProduction.js';
import * as api from '../../services/apiMusicVideo.js';

const run = (over = {}) => ({
  id: 'run-1', status: 'running', interrupted: false, directive: '', stopReason: null, error: null,
  pool: [{ kind: 'image', mode: 'local', model: null }, { kind: 'video', mode: 'local', model: null }],
  limits: { maxGenerations: 12, maxReviewAttempts: 3, spendCapUsd: null },
  usage: { generations: 2, spentUsd: 0 },
  steps: [{ key: 'frame:s1:base:1', kind: 'frame', sceneId: 's1', route: { kind: 'image', mode: 'local', model: null }, rationale: 'first eligible', status: 'queued', error: null }],
  ...over,
});

function Harness({ initial }) {
  const [project, setProject] = useState(initial);
  const production = useMusicVideoProduction({ project, replaceProject: setProject });
  return <ProductionPanel project={project} production={production} />;
}

describe('ProductionPanel', () => {
  beforeEach(() => { vi.clearAllMocks(); listeners.clear(); });

  it('starts only when the director presses Start, with the allowed pool and limits', async () => {
    api.startMusicVideoProduction.mockResolvedValue({ project: { id: 'p1', productionRuns: [run()] }, run: run() });
    render(<Harness initial={{ id: 'p1', productionRuns: [] }} />);
    expect(api.startMusicVideoProduction).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Max generations'), { target: { value: '5' } });
    fireEvent.click(screen.getByRole('button', { name: /Start production/ }));
    await waitFor(() => expect(api.startMusicVideoProduction).toHaveBeenCalled());
    const [id, body] = api.startMusicVideoProduction.mock.calls[0];
    expect(id).toBe('p1');
    expect(body.limits).toEqual({ maxGenerations: 5, maxReviewAttempts: 3 });
    expect(body.pool.length).toBeGreaterThan(1);
    expect(body.pool.every((r) => ['image', 'video'].includes(r.kind) && r.mode)).toBe(true);
    expect(await screen.findByText('Running')).toBeTruthy();
  });

  it('shows an interrupted run and resumes it only on request; pushed projects update it', async () => {
    api.resumeMusicVideoProduction.mockResolvedValue({ project: { id: 'p1', productionRuns: [run()] }, run: run() });
    render(<Harness initial={{ id: 'p1', productionRuns: [run({ interrupted: true })] }} />);
    expect(screen.getByText(/server restarted/)).toBeTruthy();
    expect(api.resumeMusicVideoProduction).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /Resume/ }));
    await waitFor(() => expect(api.resumeMusicVideoProduction).toHaveBeenCalledWith('p1', 'run-1', {}, { silent: true }));

    act(() => listeners.get('music-video:production')({
      projectId: 'p1', run: run({ status: 'blocked' }),
      project: { id: 'p1', productionRuns: [run({ status: 'blocked', stopReason: 'No allowed route can generate the frame' })] },
    }));
    expect(await screen.findByText(/No allowed route can generate the frame/)).toBeTruthy();
  });
});
