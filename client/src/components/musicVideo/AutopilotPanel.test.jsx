/**
 * Autopilot panel: the brief's kickoff ("Analyze & plan" — steps run in order
 * on the freshest project, the panel names the step running, a step whose
 * result already exists is skipped, and a failed lyric step still plans while
 * a failed analysis stops the run) and the server-owned production run (#9066)
 * over the real useMusicVideoProduction hook with a mocked API and socket: a
 * run starts only with the director's explicit pool and limits, a
 * restart-interrupted run is resumed explicitly, and a pushed project updates
 * the visible run.
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

import AutopilotPanel from './AutopilotPanel.jsx';
import useMusicVideoKickoff from '../../hooks/useMusicVideoKickoff.js';
import useMusicVideoProduction from '../../hooks/useMusicVideoProduction.js';
import * as api from '../../services/apiMusicVideo.js';

const IDLE_PRODUCTION = { busy: false, start: vi.fn(), resume: vi.fn(), stop: vi.fn(), cancel: vi.fn() };
const automation = { tools: ['local-image'], guidance: 'Moody neon', budgetUsd: null };

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

function KickoffHarness({ project, steps }) {
  const kickoff = useMusicVideoKickoff(steps);
  return (
    <AutopilotPanel
      project={project}
      production={IDLE_PRODUCTION}
      onSave={vi.fn()}
      onKickoff={() => kickoff.run(project)}
      kickoffBusy={kickoff.running}
      kickoffStep={kickoff.stepLabel}
    />
  );
}

const cue = (id, text, words) => ({ id, text, startSec: null, endSec: null, ...(words ? { words } : {}) });

describe('AutopilotPanel kickoff', () => {
  it('analyzes, imports track lyrics, separates vocals, aligns and plans — showing each step', async () => {
    const order = [];
    const base = { id: 'mv-1', trackId: 't1', automation, lyricCues: [] };
    const analyzed = { ...base, audioAnalysis: { sections: [] } };
    const withLyrics = { ...analyzed, lyricCues: [cue('lc-1', 'hold on')] };
    const withStem = { ...withLyrics, vocalStemFilename: 'stem.wav' };
    const aligned = { ...withStem, lyricCues: [cue('lc-1', 'hold on', [{ w: 'hold' }, { w: 'on' }])] };
    const separating = deferred();
    const steps = {
      analyze: vi.fn(async () => { order.push('analyze'); return analyzed; }),
      importLyrics: vi.fn(async (p) => { order.push(['lyrics', p]); return withLyrics; }),
      separateVocals: vi.fn((p) => { order.push(['vocals', p]); return separating.promise; }),
      alignLyrics: vi.fn(async (p) => { order.push(['align', p]); return aligned; }),
      plan: vi.fn(async (p) => { order.push(['plan', p]); }),
    };
    render(<KickoffHarness project={base} steps={steps} />);
    fireEvent.click(screen.getByRole('button', { name: /Analyze & plan/ }));

    expect(await screen.findByRole('status')).toHaveTextContent('Separating vocals…');
    expect(screen.getByRole('button', { name: /Working/ }).disabled).toBe(true);
    separating.resolve(withStem);

    await waitFor(() => expect(steps.plan).toHaveBeenCalled());
    expect(order).toEqual([
      'analyze',
      ['lyrics', analyzed],
      ['vocals', withLyrics],
      ['align', withStem],
      ['plan', aligned],
    ]);
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
  });

  it('skips what already exists, and still plans when the lyric import fails', async () => {
    const project = {
      id: 'mv-2', trackId: 't1', automation, audioAnalysis: { sections: [] }, vocalStemFilename: 'stem.wav', lyricCues: [],
    };
    const steps = {
      analyze: vi.fn(),
      importLyrics: vi.fn(async () => null),
      separateVocals: vi.fn(),
      alignLyrics: vi.fn(),
      plan: vi.fn(async () => {}),
    };
    render(<KickoffHarness project={project} steps={steps} />);
    fireEvent.click(screen.getByRole('button', { name: /Analyze & plan/ }));
    await waitFor(() => expect(steps.plan).toHaveBeenCalledWith(project));
    expect(steps.analyze).not.toHaveBeenCalled();
    expect(steps.importLyrics).toHaveBeenCalledOnce();
    // No lyric lines means nothing to separate or align.
    expect(steps.separateVocals).not.toHaveBeenCalled();
    expect(steps.alignLyrics).not.toHaveBeenCalled();
  });

  it('stops when the analysis fails', async () => {
    const analyzing = deferred();
    const steps = {
      analyze: vi.fn(() => analyzing.promise),
      importLyrics: vi.fn(),
      separateVocals: vi.fn(),
      alignLyrics: vi.fn(),
      plan: vi.fn(),
    };
    render(<KickoffHarness project={{ id: 'mv-3', trackId: 't1', automation, lyricCues: [] }} steps={steps} />);
    const button = screen.getByRole('button', { name: /Analyze & plan/ });
    fireEvent.click(button);
    expect(await screen.findByRole('status')).toHaveTextContent('Analyzing the song…');
    analyzing.resolve(null);
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
    expect(steps.analyze).toHaveBeenCalledOnce();
    expect(steps.importLyrics).not.toHaveBeenCalled();
    expect(steps.plan).not.toHaveBeenCalled();
  });
});

const run = (over = {}) => ({
  id: 'run-1', status: 'running', interrupted: false, directive: '', stopReason: null, error: null,
  pool: [{ kind: 'image', mode: 'local', model: null }, { kind: 'video', mode: 'local', model: null }],
  limits: { maxGenerations: 12, maxReviewAttempts: 3, spendCapUsd: null },
  usage: { generations: 2, spentUsd: 0 },
  steps: [{ key: 'frame:s1:base:1', kind: 'frame', sceneId: 's1', route: { kind: 'image', mode: 'local', model: null }, rationale: 'first eligible', status: 'queued', error: null }],
  ...over,
});

function ProductionHarness({ initial }) {
  const [project, setProject] = useState(initial);
  const production = useMusicVideoProduction({ project, replaceProject: setProject });
  return <AutopilotPanel project={project} production={production} onSave={vi.fn()} onKickoff={vi.fn()} kickoffBusy={false} />;
}

describe('AutopilotPanel production run', () => {
  beforeEach(() => { vi.clearAllMocks(); listeners.clear(); });

  it('starts only when the director presses Start, with the allowed pool and limits', async () => {
    api.startMusicVideoProduction.mockResolvedValue({ project: { id: 'p1', productionRuns: [run()] }, run: run() });
    render(<ProductionHarness initial={{ id: 'p1', productionRuns: [] }} />);
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
    render(<ProductionHarness initial={{ id: 'p1', productionRuns: [run({ interrupted: true })] }} />);
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
