import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import CitySettingsDrawer from './CitySettingsDrawer';
import { CitySettingsProvider } from './CitySettingsContext';

function Loc() {
  const l = useLocation();
  return <div data-testid="loc">{l.search}</div>;
}

const renderDrawer = (search = '', onClose = () => {}) =>
  render(
    <MemoryRouter initialEntries={[`/city/settings${search}`]}>
      <CitySettingsProvider>
        <CitySettingsDrawer open onClose={onClose} />
      </CitySettingsProvider>
      <Loc />
    </MemoryRouter>,
  );

describe('CitySettingsDrawer', () => {
  it('renders the shared Drawer with the four grouped tabs', () => {
    renderDrawer();
    expect(screen.getByRole('dialog', { name: 'City Settings' })).toBeInTheDocument();
    ['Performance', 'Audio', 'Visual', 'Explore'].forEach(label => {
      expect(screen.getByRole('tab', { name: label })).toBeInTheDocument();
    });
    // Default tab content.
    expect(screen.getByText('QUALITY')).toBeInTheDocument();
  });

  it('switches tabs and persists the active tab in the URL', () => {
    renderDrawer();
    fireEvent.click(screen.getByRole('tab', { name: 'Audio' }));
    expect(screen.getByText('MUSIC')).toBeInTheDocument();
    expect(screen.queryByText('QUALITY')).not.toBeInTheDocument();
    expect(screen.getByTestId('loc').textContent).toContain('cityTab=audio');
  });

  it('shows the Auto effective-tier label and local diagnostics when in Auto mode', () => {
    render(
      <MemoryRouter initialEntries={['/city/settings']}>
        <CitySettingsProvider>
          <CitySettingsDrawer
            open
            onClose={() => {}}
            qualityMode="auto"
            effectiveTier="medium"
            diagnostics={{ fps: 58, p75: 16.2 }}
          />
        </CitySettingsProvider>
      </MemoryRouter>,
    );
    // AUTO button reflects the effective tier, and the local diagnostics readout renders.
    expect(screen.getByRole('button', { name: /AUTO · MEDIUM/ })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('58 FPS')).toBeInTheDocument();
    expect(screen.getByText('P75 16.2ms')).toBeInTheDocument();
    // The Auto-controlled particle-density slider is disabled.
    expect(screen.getByLabelText('PARTICLE DENSITY')).toBeDisabled();
  });

  it('deep-links the active tab from the URL param', () => {
    renderDrawer('?cityTab=visual');
    expect(screen.getByText('VISUAL FX')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Visual', selected: true })).toBeInTheDocument();
  });

  it('invokes onClose from the Drawer close control', () => {
    const onClose = vi.fn();
    renderDrawer('', onClose);
    fireEvent.click(screen.getByRole('button', { name: 'Close city settings' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('renders nothing when closed', () => {
    const { container } = render(
      <MemoryRouter initialEntries={['/city']}>
        <CitySettingsProvider>
          <CitySettingsDrawer open={false} onClose={() => {}} />
        </CitySettingsProvider>
      </MemoryRouter>,
    );
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });
});
