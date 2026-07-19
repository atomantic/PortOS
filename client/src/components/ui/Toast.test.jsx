import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, act } from '@testing-library/react';

import { toast, Toaster } from './Toast.jsx';

afterEach(() => {
  act(() => toast.dismiss());
  cleanup();
  vi.unstubAllGlobals();
});

describe('Toast on an insecure origin', () => {
  // Regression: `add()` minted ids with a bare `crypto.randomUUID()`, which is
  // undefined outside a secure context. PortOS is routinely reached over plain
  // HTTP via Tailscale, so EVERY toast threw `crypto.randomUUID is not a
  // function` there — including the error toasts the API client raises to
  // report a failure, which surfaced it as an unhandled rejection.
  it('renders without crypto.randomUUID (plain HTTP via Tailscale)', () => {
    vi.stubGlobal('crypto', {
      getRandomValues: globalThis.crypto.getRandomValues.bind(globalThis.crypto),
    });
    expect(globalThis.crypto.randomUUID).toBeUndefined();

    render(<Toaster />);
    expect(() => act(() => { toast.error('Request failed'); })).not.toThrow();
    expect(screen.getByRole('alert')).toHaveTextContent('Request failed');
  });
});

describe('Toaster accessibility', () => {
  it('exposes the toast stack as a labelled notification region', () => {
    render(<Toaster />);
    const region = screen.getByRole('region', { name: 'Notifications' });
    expect(region).toBeInTheDocument();
  });

  it('announces a default toast politely (role="status") without a redundant aria-live', () => {
    render(<Toaster />);
    act(() => { toast('Saved'); });
    const status = screen.getByRole('status');
    expect(status).toHaveTextContent('Saved');
    // role="status" already implies aria-live="polite"; pairing both
    // double-announces in iOS VoiceOver, so aria-live must be absent.
    expect(status).not.toHaveAttribute('aria-live');
  });

  it('announces an error toast assertively (role="alert") without a redundant aria-live', () => {
    render(<Toaster />);
    act(() => { toast.error('Boom'); });
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Boom');
    // role="alert" already implies aria-live="assertive".
    expect(alert).not.toHaveAttribute('aria-live');
  });

  it('hides the decorative status glyph from assistive tech', () => {
    render(<Toaster />);
    act(() => { toast.success('Done'); });
    const status = screen.getByRole('status');
    const glyph = status.querySelector('[aria-hidden="true"]');
    expect(glyph).toHaveTextContent('✓');
  });
});
