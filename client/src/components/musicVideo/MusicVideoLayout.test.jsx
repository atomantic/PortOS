import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import MusicVideoLayout, { stepState } from './MusicVideoLayout.jsx';
import { MUSIC_VIDEO_STAGES } from '../../lib/musicVideoStages.js';

const progressFor = (current, states = {}) => ({
  current, stages: MUSIC_VIDEO_STAGES.map((stage) => ({ ...stage, state: states[stage.id] || (stage.id === current ? 'active' : 'todo') })),
});

describe('music-video step navigation', () => {
  it('lists the six steps with a state word and one fact each, and opens a step on click', () => {
    const onStageChange = vi.fn();
    render(<MusicVideoLayout project={{ id: 'example-project', name: 'Example Project', version: 2 }} stage="board" trackLabel="Example Track"
      onStageChange={onStageChange} progress={progressFor('board', { setup: 'done', 'cast-sets': 'done' })}
      status={{ headline: 'Step 3 of 6: Storyboard needs you', tone: 'warn', facts: [] }}
      notes={{ setup: '4:40 · 70 lyric lines', board: '26 shots' }}
      spend={{ spentUsd: 3, capUsd: 10 }} />);
    const steps = within(screen.getByRole('navigation', { name: 'Steps' })).getAllByRole('button');
    expect(steps.map((step) => step.textContent)).toEqual([
      'Song' + 'Done' + '4:40 · 70 lyric lines',
      'Look' + 'Done',
      '3Storyboard' + 'Needs you' + '26 shots',
      '4Make' + 'Not started',
      '5Final render' + 'Not started',
      '6Publish' + 'Not started',
    ]);
    expect(steps[2]).toHaveAttribute('aria-current', 'step');
    fireEvent.click(steps[3]);
    expect(onStageChange).toHaveBeenCalledWith('produce');
    // The step names what "done" means under its title.
    expect(screen.getByRole('heading', { level: 3, name: 'Storyboard' })).toBeInTheDocument();
    expect(screen.getByText(MUSIC_VIDEO_STAGES[2].doneWhen)).toBeInTheDocument();
    // The track, version and spend stay in the header.
    expect(screen.getByText('Example Track')).toBeInTheDocument();
    expect(screen.getByText('v2')).toBeInTheDocument();
    expect(screen.getByText(/\$3\.00 \/ \$10\.00/)).toBeInTheDocument();
  });

  it('says where the project stands in one line, without status chips', () => {
    render(<MusicVideoLayout project={{ id: 'example-project', name: 'Example Project' }} stage="cast-sets"
      onStageChange={() => {}} progress={progressFor('cast-sets')} spend={{ spentUsd: 0 }}
      status={{ headline: 'Step 2 of 6: Look needs you', tone: 'warn', facts: [{ id: 'render', label: 'Nothing rendered yet', tone: 'muted' }] }} />);
    const status = screen.getByRole('status', { name: 'Project status' });
    expect(status).toHaveTextContent(/^Step 2 of 6: Look needs you$/);
    expect(screen.queryByText('Nothing rendered yet')).not.toBeInTheDocument();
  });

  it('opens Project settings and its Autopilot tab from the header', () => {
    const onOpenSettings = vi.fn();
    render(<MusicVideoLayout project={{ id: 'example-project', name: 'Example Project' }} stage="setup"
      onStageChange={() => {}} progress={progressFor('setup')} spend={{ spentUsd: 0 }}
      autopilot={{ label: 'Autonomous run: writing the lyric draft', tone: 'muted' }} onOpenSettings={onOpenSettings} />);
    fireEvent.click(screen.getByRole('button', { name: 'Project settings' }));
    expect(onOpenSettings).toHaveBeenLastCalledWith('project');
    fireEvent.click(screen.getByRole('button', { name: /Autonomous run: writing the lyric draft/ }));
    expect(onOpenSettings).toHaveBeenLastCalledWith('autopilot');
  });

  it('keeps the project name from a long next action on a phone (#10170)', () => {
    render(<MusicVideoLayout project={{ id: 'example-project', name: 'Example Project Name' }} stage="board"
      onStageChange={() => {}} progress={progressFor('board')} spend={{ spentUsd: 1.2, capUsd: 10 }}
      nextAction={{ id: 'review-production', kind: 'goto', label: 'Review timed storyboard', shortLabel: 'Board' }}
      onNextAction={() => {}} />);
    const name = screen.getByRole('heading', { level: 2, name: 'Example Project Name' });
    expect(name).toHaveClass('truncate');
    expect(name.parentElement).toHaveClass('min-w-0');
    const action = screen.getByRole('button', { name: 'Review timed storyboard' });
    expect(action.querySelector('.sm\\:hidden')).toHaveTextContent('Board');
  });

  it('keeps every step in the phone icon bar, each with its own icon', () => {
    render(<MusicVideoLayout project={{ id: 'example-project', name: 'Example Project' }} stage="publish"
      onStageChange={() => {}} progress={progressFor('publish')} spend={{ spentUsd: 0 }} />);
    const navigation = within(screen.getByRole('navigation', { name: 'Stages' }));
    expect(navigation.queryByRole('combobox')).not.toBeInTheDocument();
    const tabs = navigation.getAllByRole('tab');
    expect(tabs).toHaveLength(MUSIC_VIDEO_STAGES.length);
    const icons = tabs.map((tab) => tab.querySelector('svg')?.getAttribute('class'));
    expect(icons.every(Boolean)).toBe(true);
    expect(new Set(icons).size).toBe(tabs.length);
    expect(navigation.getByRole('tab', { name: /^Publish/ })).toHaveAttribute('aria-selected', 'true');
  });
});

describe('stepState', () => {
  it('uses one word per state, flagging a changed approval and the current step that waits on the director', () => {
    const at = (entry, needsYou = false) => stepState({ id: 'board', ...entry }, { current: 'board', needsYou }).word;
    expect(at({ state: 'done' })).toBe('Done');
    expect(at({ state: 'done', stale: true })).toBe('Changed since approval');
    expect(at({ state: 'blocked' })).toBe('Needs you');
    expect(at({ state: 'active' }, true)).toBe('Needs you');
    expect(at({ state: 'active' })).toBe('In progress');
    expect(at({ state: 'todo', stale: true })).toBe('Changed since approval');
    expect(stepState({ id: 'review', state: 'todo' }, { current: 'board', needsYou: true }).word).toBe('Not started');
  });
});
