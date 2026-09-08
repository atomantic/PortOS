import {
  afterEach, describe, expect, it, vi,
} from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import NetworkLogo, { networkLabel } from './BeeperNetworkLogo';

/**
 * #84: the Google Messages and Signal marks were both solid blue speech
 * bubbles, indistinguishable at rail size; Facebook and Beeper fell back to
 * grey letter chips because the ids Beeper actually emits for those two
 * ("facebookgo"/"messenger" for Facebook, and Beeper's own network) never
 * normalized onto a key `MARKS` held a mark for.
 *
 * These tests pin: distinct silhouettes for Google Messages vs. Signal, a
 * Beeper mark, every Facebook/Messenger alias resolving to the one
 * `facebook` mark and label, the letter-chip fallback for a truly unknown
 * id, and the once-per-id dev-only console log that makes that fallback
 * visible without spamming.
 */

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('BeeperNetworkLogo — Google Messages vs. Signal', () => {
  it('renders Google Messages as a filled speech-bubble path', () => {
    render(<NetworkLogo network="googlemessages" />);
    const mark = screen.getByRole('img', { name: 'Google Messages' });
    expect(mark.querySelector('path')).toBeTruthy();
    expect(mark.querySelector('circle')).toBeNull();
  });

  it('renders Signal as a dashed/dotted ring, not a speech bubble', () => {
    render(<NetworkLogo network="signal" />);
    const mark = screen.getByRole('img', { name: 'Signal' });
    const ring = mark.querySelector('circle');
    expect(ring).toBeTruthy();
    // A dotted/dashed circle, not a solid one — the silhouette that actually
    // distinguishes it from Google Messages' bubble.
    expect(ring).toHaveAttribute('stroke-dasharray');
    expect(ring).toHaveAttribute('fill', 'none');
    expect(mark.querySelector('path')).toBeNull();
  });
});

describe('BeeperNetworkLogo — Beeper mark', () => {
  const beeperIds = ['beeper', 'Beeper'];

  it.each(beeperIds)('renders a dedicated Beeper mark instead of falling back for %s', (rawId) => {
    render(<NetworkLogo network={rawId} />);
    const mark = screen.getByRole('img', { name: 'Beeper' });
    expect(mark.querySelector('path')).toBeTruthy();
    // Not the neutral grey fallback chip's single-letter span.
    expect(mark.querySelector('span')).toBeNull();
  });

  it('exposes "Beeper" through networkLabel', () => {
    expect(networkLabel('beeper')).toBe('Beeper');
  });
});

describe('BeeperNetworkLogo — Facebook/Messenger id normalisation', () => {
  const aliases = [
    'facebook',
    'facebookgo',
    'messenger',
    'messengergo',
    'Facebook Go',
    'MESSENGER',
    // Beeper reports a display name, not a stable id, and the live
    // Facebook-bridge string has never been observed (#84) — these pin the
    // contains-rule fallback (`NETWORK_ALIAS_RULES`) that catches whichever
    // spelling the bridge actually emits, none of which hit the exact map.
    'Facebook Messenger',
    'facebook-messenger',
    'Facebook (Go)',
    'Messenger (Go)',
  ];

  it.each(aliases)('resolves %s to the Messenger mark', (rawId) => {
    render(<NetworkLogo network={rawId} />);
    const mark = screen.getByRole('img', { name: 'Messenger' });
    expect(mark.querySelector('path')).toBeTruthy();
    expect(mark.querySelector('span')).toBeNull();
  });

  it('labels every alias "Messenger" via networkLabel', () => {
    for (const rawId of aliases) {
      expect(networkLabel(rawId)).toBe('Messenger');
    }
  });
});

describe('BeeperNetworkLogo — unknown network fallback', () => {
  it('renders the letter-chip fallback for a network with no mark', () => {
    render(<NetworkLogo network="threema-unmapped-1" />);
    const chip = screen.getByRole('img', { name: 'threema-unmapped-1' });
    expect(chip.textContent).toBe('T');
  });

  it('prefers an explicit label prop over the raw id on the fallback chip', () => {
    render(<NetworkLogo network="threema-unmapped-2" label="Threema" />);
    const chip = screen.getByRole('img', { name: 'Threema' });
    expect(chip.textContent).toBe('T');
  });
});

describe('BeeperNetworkLogo — dev-only once-per-id unknown network log', () => {
  it('logs an unknown id once, even across repeated renders of the same id', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    render(<NetworkLogo network="unmapped-dev-log-a" />);
    render(<NetworkLogo network="unmapped-dev-log-a" />);
    render(<NetworkLogo network="unmapped-dev-log-a" />);

    const hits = warn.mock.calls.filter(([msg]) => msg.includes('unmapped-dev-log-a'));
    expect(hits).toHaveLength(1);
  });

  it('logs a different unknown id independently of one already logged', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    render(<NetworkLogo network="unmapped-dev-log-b" />);
    render(<NetworkLogo network="unmapped-dev-log-c" />);

    const bHits = warn.mock.calls.filter(([msg]) => msg.includes('unmapped-dev-log-b'));
    const cHits = warn.mock.calls.filter(([msg]) => msg.includes('unmapped-dev-log-c'));
    expect(bHits).toHaveLength(1);
    expect(cHits).toHaveLength(1);
  });

  it('does not log for a network that resolves to a known mark', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    render(<NetworkLogo network="whatsapp" />);
    render(<NetworkLogo network="facebookgo" />);
    expect(warn).not.toHaveBeenCalled();
  });

  it('stays silent outside development', () => {
    const originalDev = import.meta.env.DEV;
    import.meta.env.DEV = false;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      render(<NetworkLogo network="unmapped-dev-log-prod-guard" />);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      import.meta.env.DEV = originalDev;
    }
  });
});
