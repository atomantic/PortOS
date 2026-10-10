import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
const fixture = vi.hoisted(() => ({ status: null, options: null }));
vi.mock('../hooks/useMaintenance.js', () => ({ useMaintenance: options => { fixture.options = options; return { status: fixture.status }; } }));
import MaintenanceBanner from './MaintenanceBanner.jsx';

const show = status => { fixture.status = status; return render(<MemoryRouter><MaintenanceBanner /></MemoryRouter>); };

describe('MaintenanceBanner', () => {
  it('uses the coarse banner mode and renders the draining blocker count', () => {
    show({ state: 'draining', blockerCount: 3 });
    expect(fixture.options).toEqual({ mode: 'banner' });
    expect(screen.getByRole('status')).toHaveTextContent('3 operation(s) finishing');
  });
  it('renders nothing for normal operation and a warning for unavailable state', () => {
    const { container, unmount } = show({ state: 'normal', blockerCount: 0 });
    expect(container).toBeEmptyDOMElement();
    unmount();
    show({ state: 'unavailable', blockerCount: 0 });
    expect(screen.getByRole('status')).toHaveTextContent('readiness unknown');
  });
});
