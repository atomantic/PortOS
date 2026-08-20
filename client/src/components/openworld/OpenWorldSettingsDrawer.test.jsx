import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router';
import OpenWorldSettingsDrawer from './OpenWorldSettingsDrawer';
import { OpenWorldSettingsProvider } from './OpenWorldSettingsContext';

function Loc() {
  const l = useLocation();
  return <div data-testid="loc">{l.search}</div>;
}

const renderDrawer = (search = '', onClose = () => {}) =>
  render(
    <MemoryRouter initialEntries={[`/openworld/settings${search}`]}>
      <OpenWorldSettingsProvider>
        <OpenWorldSettingsDrawer open onClose={onClose} />
      </OpenWorldSettingsProvider>
      <Loc />
    </MemoryRouter>,
  );

describe('OpenWorldSettingsDrawer', () => {
  it('renders the shared Drawer with focused player-choice tabs', () => {
    renderDrawer();
    expect(screen.getByRole('dialog', { name: 'OpenWorld Settings' })).toBeInTheDocument();
    ['Audio', 'Visual', 'Controls'].forEach(label => {
      expect(screen.getByRole('tab', { name: label })).toBeInTheDocument();
    });
    // Default tab content.
    expect(screen.getByText('MUSIC')).toBeInTheDocument();
  });

  it('switches tabs and persists the active tab in the URL', () => {
    renderDrawer();
    fireEvent.click(screen.getByRole('tab', { name: 'Controls' }));
    expect(screen.getByText('MOVEMENT')).toBeInTheDocument();
    expect(screen.queryByText('MUSIC')).not.toBeInTheDocument();
    expect(screen.getByTestId('loc').textContent).toContain('openWorldTab=controls');
  });

  it('shows the actual exploration controls without legacy renderer knobs', () => {
    renderDrawer('?openWorldTab=controls');
    expect(screen.getByText('MOVEMENT')).toBeInTheDocument();
    expect(screen.getByText('Drop in / fly out')).toBeInTheDocument();
    expect(screen.getByText('SPACE')).toBeInTheDocument();
    expect(screen.queryByText('QUALITY')).not.toBeInTheDocument();
    expect(screen.queryByText('PARTICLE DENSITY')).not.toBeInTheDocument();
  });

  it('deep-links the active tab from the URL param', () => {
    renderDrawer('?openWorldTab=visual');
    expect(screen.getByText('WORLD')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Visual', selected: true })).toBeInTheDocument();
  });

  it('invokes onClose from the Drawer close control', () => {
    const onClose = vi.fn();
    renderDrawer('', onClose);
    fireEvent.click(screen.getByRole('button', { name: 'Close city settings' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('offers a soundscape override with Auto plus every mood, and persists the choice', () => {
    window.localStorage.clear();
    renderDrawer('?openWorldTab=audio');
    // The override rides with the music controls, so it appears once music is on.
    expect(screen.queryByLabelText('SOUNDSCAPE')).toBeNull();
    fireEvent.click(screen.getByRole('switch', { name: 'SYNTHWAVE' }));

    const select = screen.getByLabelText('SOUNDSCAPE');
    expect([...select.options].map(o => o.textContent)).toEqual(['AUTO', 'BRIGHT', 'NEUTRAL', 'TENSE']);
    expect(select.value).toBe('');

    fireEvent.change(select, { target: { value: 'tense' } });
    expect(screen.getByLabelText('SOUNDSCAPE').value).toBe('tense');
    expect(JSON.parse(window.localStorage.getItem('portos-city-settings')).soundscapeOverride).toBe('tense');

    // Back to Auto — stored as the explicit null sentinel, not an empty string.
    fireEvent.change(screen.getByLabelText('SOUNDSCAPE'), { target: { value: '' } });
    expect(screen.getByLabelText('SOUNDSCAPE').value).toBe('');
    expect(JSON.parse(window.localStorage.getItem('portos-city-settings')).soundscapeOverride).toBeNull();
    window.localStorage.clear();
  });

  it('renders nothing when closed', () => {
    const { container } = render(
      <MemoryRouter initialEntries={['/openworld']}>
        <OpenWorldSettingsProvider>
          <OpenWorldSettingsDrawer open={false} onClose={() => {}} />
        </OpenWorldSettingsProvider>
      </MemoryRouter>,
    );
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });
});
