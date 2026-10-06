import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import MusicVideoLayout, { stepState } from './MusicVideoLayout.jsx';
import { MUSIC_VIDEO_STAGES } from '../../lib/musicVideoStages.js';

// Both the step list (md+) and the phone icon bar are "Steps"; only one shows at a time.
const stepNavs = () => screen.getAllByRole('navigation', { name: 'Steps' });
const rail = () => stepNavs().find((nav) => nav.querySelector('ol'));
const phoneBar = () => stepNavs().find((nav) => nav.querySelector('[role="tablist"]'));
const progressFor = (current, states = {}) => ({
  current, stages: MUSIC_VIDEO_STAGES.map((stage) => ({ ...stage, state: states[stage.id] || (stage.id === current ? 'active' : 'todo') })),
});

describe('music-video step navigation', () => {
  it('lists the six steps with a state word and one fact each, and opens a step on click', () => {
    const onStageChange = vi.fn();
    render(<MusicVideoLayout project={{ id: 'example-project', name: 'Example Project', version: 2 }} stage="board" trackLabel="Example Track"
      onStageChange={onStageChange} progress={progressFor('board', { setup: 'done', 'cast-sets': 'done' })}
      status={{ headline: 'Step 3 of 6: Storyboard needs you', tone: 'warn', needsYouStage: 'board' }}
      notes={{ setup: '4:40 · 70 lyric lines', board: '26 shots' }}
      spend={{ spentUsd: 3, capUsd: 10 }} />);
    expect(stepNavs()).toHaveLength(2);
    const steps = within(rail()).getAllByRole('button');
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
    // The phone bar says each state to screen readers, since it shows only icons.
    expect(within(phoneBar()).getAllByRole('tab').map((tab) => tab.textContent)).toEqual([
      'Song, Done', 'Look, Done', 'Storyboard, Needs you', 'Make, Not started', 'Final render, Not started', 'Publish, Not started',
    ]);
    // The step names what "done" means under its title, and labels the panel.
    expect(screen.getByRole('tabpanel', { name: 'Storyboard' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 3, name: 'Storyboard' })).toBeInTheDocument();
    expect(screen.getByText(MUSIC_VIDEO_STAGES[2].doneWhen)).toBeInTheDocument();
    // The track, version and spend stay in the header.
    expect(screen.getByText('Example Track')).toBeInTheDocument();
    expect(screen.getByText('v2')).toBeInTheDocument();
    expect(screen.getByText(/\$3\.00 \/ \$10\.00/)).toBeInTheDocument();
  });

  it('says where the project stands in one line, and a status error marks no step as needing you', () => {
    render(<MusicVideoLayout project={{ id: 'example-project', name: 'Example Project' }} stage="cast-sets"
      onStageChange={() => {}} progress={progressFor('cast-sets')} spend={{ spentUsd: 0 }}
      status={{ headline: 'Status unavailable: offline', tone: 'warn', needsYouStage: null }} />);
    const status = screen.getByRole('status', { name: 'Project status' });
    expect(status).toHaveTextContent(/^Status unavailable: offline$/);
    expect(within(rail()).queryByText('Needs you')).not.toBeInTheDocument();
  });

  it('opens Project settings and its Autopilot tab from the header', () => {
    const onOpenSettings = vi.fn();
    render(<MusicVideoLayout project={{ id: 'example-project', name: 'Example Project' }} stage="setup"
      onStageChange={() => {}} progress={progressFor('setup')} spend={{ spentUsd: 0 }}
      autopilot={{ label: 'Autonomous run: writing the lyric draft', short: 'Autopilot running', tone: 'muted' }} onOpenSettings={onOpenSettings} />);
    fireEvent.click(screen.getByRole('button', { name: 'Project settings' }));
    expect(onOpenSettings).toHaveBeenLastCalledWith('project');
    const autopilot = screen.getByRole('button', { name: /Autonomous run: writing the lyric draft/ });
    // A phone shows the short label so the sticky header stays one row.
    expect(autopilot.querySelector('.sm\\:hidden')).toHaveTextContent('Autopilot running');
    fireEvent.click(autopilot);
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
    const navigation = within(phoneBar());
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
  it('uses one word per state, flagging a changed approval and the step that waits on the director', () => {
    const at = (entry, needsYouStage = null) => stepState({ id: 'board', ...entry }, { needsYouStage }).word;
    expect(at({ state: 'done' })).toBe('Done');
    expect(at({ state: 'done', stale: true })).toBe('Changed since approval');
    expect(at({ state: 'blocked' })).toBe('Needs you');
    expect(at({ state: 'active' }, 'board')).toBe('Needs you');
    // An approval on a later step marks that step, not the first unfinished one.
    expect(at({ state: 'todo' }, 'board')).toBe('Needs you');
    expect(at({ state: 'active' }, 'cast-sets')).toBe('In progress');
    expect(at({ state: 'active' })).toBe('In progress');
    expect(at({ state: 'todo', stale: true })).toBe('Changed since approval');
    expect(at({ state: 'todo' })).toBe('Not started');
  });
});
