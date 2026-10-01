import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import MusicVideoLayout from './MusicVideoLayout.jsx';
import { MUSIC_VIDEO_STAGES } from '../../lib/musicVideoStages.js';

describe('music-video stage navigation', () => {
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
