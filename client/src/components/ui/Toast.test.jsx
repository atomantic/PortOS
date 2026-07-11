import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, act } from '@testing-library/react';

import { toast, Toaster } from './Toast.jsx';

afterEach(() => {
  act(() => toast.dismiss());
  cleanup();
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
