import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import MusicVideoLayout from './MusicVideoLayout.jsx';
import { MUSIC_VIDEO_STAGES } from '../../lib/musicVideoStages.js';

describe('music-video stage navigation', () => {
  it('renders one stage row: the tabs carry the status marks, with no separate progress strip', () => {
    const states = ['done', 'active', 'blocked', 'todo', 'todo', 'todo', 'todo'];
    render(<MusicVideoLayout project={{ id: 'example-project', name: 'Example Project' }} stage="cast-sets" trackLabel="Example Track"
      onStageChange={() => {}} progress={{ current: 'cast-sets', stages: MUSIC_VIDEO_STAGES.map((stage, i) => ({ ...stage, state: states[i] })) }}
      spend={{ spentUsd: 3, capUsd: 10 }} />);
    expect(screen.queryByRole('list', { name: 'Progress' })).not.toBeInTheDocument();
    const tabs = within(screen.getByRole('navigation', { name: 'Stages' })).getAllByRole('tab');
    expect(tabs).toHaveLength(MUSIC_VIDEO_STAGES.length);
    expect(within(tabs[0]).getByLabelText('done')).toBeInTheDocument();
    expect(within(tabs[1]).getByLabelText('in progress')).toBeInTheDocument();
    expect(within(tabs[2]).getByLabelText('needs you')).toBeInTheDocument();
    // The track and spend chips survive the strip's removal.
    expect(screen.getByText('Example Track')).toBeInTheDocument();
    expect(screen.getByText(/\$3\.00 \/ \$10\.00/)).toBeInTheDocument();
  });

  it('says where the project stands under its name', () => {
    render(<MusicVideoLayout project={{ id: 'example-project', name: 'Example Project' }} stage="cast-sets"
      onStageChange={() => {}} progress={{ current: 'cast-sets', stages: MUSIC_VIDEO_STAGES.map((stage) => ({ ...stage, state: 'todo' })) }}
      spend={{ spentUsd: 0 }}
      status={{ headline: 'Stage 2 of 7: Cast & Sets · needs you', tone: 'warn', facts: [{ id: 'render', label: 'Nothing rendered yet', tone: 'muted' }] }} />);
    const status = screen.getByRole('status', { name: 'Project status' });
    expect(status).toHaveTextContent('Stage 2 of 7: Cast & Sets · needs you');
    expect(status).toHaveTextContent('Nothing rendered yet');
  });

  it('keeps every fixed stage in the compact icon row after adding Publish', () => {
    render(<MusicVideoLayout project={{ id: 'example-project', name: 'Example Project' }} stage="publish"
      onStageChange={() => {}} progress={{ current: 'publish', stages: MUSIC_VIDEO_STAGES.map((stage) => ({ ...stage, state: 'todo' })) }}
      spend={{ spentUsd: 0 }} />);
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

describe('project rename affordance', () => {
  it('shows a rename button beside the project name that calls onRename', () => {
    const onRename = vi.fn();
    render(<MusicVideoLayout project={{ id: 'example-project', name: 'Example Project' }} stage="setup"
      onStageChange={() => {}} onRename={onRename}
      progress={{ current: 'setup', stages: MUSIC_VIDEO_STAGES.map((stage) => ({ ...stage, state: 'todo' })) }}
      spend={{ spentUsd: 0 }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Rename project' }));
    expect(onRename).toHaveBeenCalledTimes(1);
  });
});
