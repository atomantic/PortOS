/**
 * Autopilot kickoff ("Analyze & plan"): the steps run in order on the
 * freshest project, the panel names the step that is running, a step whose
 * result already exists is skipped, and a failed lyric step still plans while
 * a failed analysis stops the run.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import AutomationPanel from './AutomationPanel.jsx';
import useMusicVideoKickoff from '../../hooks/useMusicVideoKickoff.js';

const automation = { tools: ['local-image'], guidance: 'Moody neon', budgetUsd: null };

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

function Harness({ project, steps }) {
  const kickoff = useMusicVideoKickoff(steps);
  return (
    <AutomationPanel
      project={project}
      onSave={vi.fn()}
      onKickoff={() => kickoff.run(project)}
      kickoffBusy={kickoff.running}
      kickoffStep={kickoff.stepLabel}
    />
  );
}

const cue = (id, text, words) => ({ id, text, startSec: null, endSec: null, ...(words ? { words } : {}) });

describe('AutomationPanel autopilot kickoff', () => {
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
    render(<Harness project={base} steps={steps} />);
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
    render(<Harness project={project} steps={steps} />);
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
    render(<Harness project={{ id: 'mv-3', trackId: 't1', automation, lyricCues: [] }} steps={steps} />);
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
