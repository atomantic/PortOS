import { describe, it, expect, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';

// StyleProbeImage loads pipeline-image settings on mount; flush that microtask
// so the async setState lands inside act() and the test output stays clean.
const flushEffects = () => act(async () => { await Promise.resolve(); });

vi.mock('../../services/api', () => ({
  getSettings: vi.fn(() => Promise.resolve({})),
  generateImage: vi.fn(() => Promise.resolve(null)),
  updateUniverse: vi.fn(() => Promise.resolve(null)),
}));

import StyleProbeImage, { buildStyleProbePrompt, hasStyleForProbe, probeStyleKey, shouldPersistProbe } from './StyleProbeImage';

describe('StyleProbeImage — buildStyleProbePrompt', () => {
  it('uses embrace tokens as positive and avoid tokens as negative', () => {
    const u = {
      styleNotes: 'inky noir, heavy rain',
      influences: { embrace: ['high contrast', 'cinematic'], avoid: ['bright', 'pastel'] },
    };
    const { prompt, negativePrompt } = buildStyleProbePrompt(u);
    expect(prompt).toContain('high contrast');
    expect(prompt).toContain('cinematic');
    expect(negativePrompt).toContain('bright');
    expect(negativePrompt).toContain('pastel');
  });

  it('omits styleNotes — downstream image prompts do not include them, so the probe must not either', () => {
    const u = {
      styleNotes: 'inky noir, heavy rain',
      influences: { embrace: ['high contrast'], avoid: [] },
    };
    expect(buildStyleProbePrompt(u).prompt).not.toContain('inky noir');
    expect(buildStyleProbePrompt(u).prompt).not.toContain('heavy rain');
  });

  it('produces an empty prompt when only styleNotes is present (no embrace influences)', () => {
    expect(buildStyleProbePrompt({ styleNotes: 'watercolor' }).prompt).toBe('');
  });

  it('returns empty for a null / style-less universe', () => {
    expect(buildStyleProbePrompt(null)).toEqual({ prompt: '', negativePrompt: '' });
    expect(buildStyleProbePrompt({ influences: { embrace: [], avoid: [] } }).prompt).toBe('');
  });
});

describe('StyleProbeImage — hasStyleForProbe', () => {
  it('is true when there is any embrace influence', () => {
    expect(hasStyleForProbe({ influences: { embrace: ['noir'] } })).toBe(true);
  });
  it('is false with only styleNotes — those do not reach the image model', () => {
    expect(hasStyleForProbe({ styleNotes: 'x' })).toBe(false);
  });
  it('is false with no style at all', () => {
    expect(hasStyleForProbe(null)).toBe(false);
    expect(hasStyleForProbe({ influences: { embrace: [], avoid: ['bright'] } })).toBe(false);
  });
});

describe('StyleProbeImage — probeStyleKey (mid-render drift guard)', () => {
  it('changes when the influences that feed the probe change', () => {
    const a = { influences: { embrace: ['noir'], avoid: [] } };
    const b = { influences: { embrace: ['noir', 'cinematic'], avoid: [] } };
    // The completion handler compares this key against the render-time capture
    // to skip persisting a probe whose style drifted while it rendered.
    expect(probeStyleKey(a)).not.toBe(probeStyleKey(b));
  });

  it('is stable across edits that do not reach the image model (styleNotes)', () => {
    const a = { styleNotes: 'one', influences: { embrace: ['noir'], avoid: [] } };
    const b = { styleNotes: 'two', influences: { embrace: ['noir'], avoid: [] } };
    expect(probeStyleKey(a)).toBe(probeStyleKey(b));
  });
});

describe('StyleProbeImage — shouldPersistProbe (async completion guard)', () => {
  const A = 'keyA';
  const B = 'keyB';

  it('persists when the draft is clean and the live style still matches the queued probe', () => {
    expect(shouldPersistProbe({ styleDirty: false, capturedKey: A, currentKey: A })).toBe(true);
  });

  it('drops when influences were saved to a different style mid-render', () => {
    // queued A, then edited + saved B → live key is now B (clean), captured A.
    expect(shouldPersistProbe({ styleDirty: false, capturedKey: A, currentKey: B })).toBe(false);
  });

  it('drops the codex revert case: queued A, saved B, draft reverted to A but unsaved', () => {
    // draft key matches captured A, but draft != saved (B) so styleDirty is true.
    // Without the styleDirty guard the A image would wrongly pin to the saved B record.
    expect(shouldPersistProbe({ styleDirty: true, capturedKey: A, currentKey: A })).toBe(false);
  });

  it('drops on unsaved style edits during render (conservative — safe re-run)', () => {
    expect(shouldPersistProbe({ styleDirty: true, capturedKey: A, currentKey: B })).toBe(false);
  });

  it('drops when no probe was queued (captured key absent)', () => {
    expect(shouldPersistProbe({ styleDirty: false, capturedKey: null, currentKey: A })).toBe(false);
  });
});

describe('StyleProbeImage — styleDirty gating', () => {
  const universe = { id: 'u1', influences: { embrace: ['noir'], avoid: [] }, styleImageRefs: [] };

  it('disables the render button and warns when the draft style is unsaved', async () => {
    render(<StyleProbeImage universe={universe} styleDirty />);
    await flushEffects();
    // The empty-state slot button is inert until the style is saved, so the
    // probe can never pin to a record that lacks the in-progress influences.
    expect(screen.getByRole('button')).toBeDisabled();
    expect(screen.getByText(/Save your style changes first/i)).toBeInTheDocument();
  });

  it('enables the render button and shows no warning when the style is saved', async () => {
    render(<StyleProbeImage universe={universe} styleDirty={false} />);
    await flushEffects();
    expect(screen.getByRole('button')).toBeEnabled();
    expect(screen.queryByText(/Save your style changes first/i)).not.toBeInTheDocument();
  });
});
