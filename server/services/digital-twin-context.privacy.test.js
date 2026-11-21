/**
 * Gating tests for Privacy Vault injection into the digital twin prompt
 * (issue #2147). Verifies the GLOBAL gate (includePrivacyContext): the block
 * is fetched + injected only when the setting is on. loadMeta and the privacy
 * context builder are mocked — no fs docs, no DB.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

import { PRIVACY_FACTS_HEADING, PRIVACY_FACTS_NOTICE, redactStoredPrivacyPrompt } from '../lib/privacyPrompt.js';

const loadMeta = vi.fn();
const getPrivacyTwinContext = vi.fn();

vi.mock('./digital-twin-meta.js', () => ({ loadMeta: (...a) => loadMeta(...a) }));
vi.mock('./privacyTwinContext.js', () => ({ getPrivacyTwinContext: (...a) => getPrivacyTwinContext(...a) }));

const { getDigitalTwinForPrompt } = await import('./digital-twin-context.js');

function metaWith(settings) {
  return { settings: { autoInjectToCoS: true, maxContextTokens: 4000, ...settings }, documents: [], personas: [], traits: {} };
}

beforeEach(() => {
  loadMeta.mockReset();
  getPrivacyTwinContext.mockReset();
  getPrivacyTwinContext.mockResolvedValue([PRIVACY_FACTS_HEADING, PRIVACY_FACTS_NOTICE, '- Legal name — legal_name: Skylar Example'].join('\n'));
});

describe('getDigitalTwinForPrompt privacy gate', () => {
  it('does NOT fetch or inject the privacy block when includePrivacyContext is off', async () => {
    loadMeta.mockResolvedValue(metaWith({ includePrivacyContext: false }));
    const out = await getDigitalTwinForPrompt();
    expect(getPrivacyTwinContext).not.toHaveBeenCalled();
    expect(out).not.toContain('Privacy Vault');
  });

  it('injects the privacy block when includePrivacyContext is on', async () => {
    loadMeta.mockResolvedValue(metaWith({ includePrivacyContext: true }));
    const out = await getDigitalTwinForPrompt();
    expect(getPrivacyTwinContext).toHaveBeenCalledTimes(1);
    expect(out).toContain('# Identity Facts (Privacy Vault)');
    expect(out).toContain('Skylar Example');
    expect(redactStoredPrivacyPrompt(out)).not.toContain('Skylar Example');
  });

  it('degrades to no block (no throw) when the privacy builder fails', async () => {
    loadMeta.mockResolvedValue(metaWith({ includePrivacyContext: true }));
    getPrivacyTwinContext.mockRejectedValue(new Error('db down'));
    const out = await getDigitalTwinForPrompt();
    expect(out).not.toContain('Privacy Vault');
  });

  it('emits nothing from the vault when autoInject is off (no injection at all)', async () => {
    loadMeta.mockResolvedValue(metaWith({ autoInjectToCoS: false, includePrivacyContext: true }));
    const out = await getDigitalTwinForPrompt();
    expect(out).toBe('');
    expect(getPrivacyTwinContext).not.toHaveBeenCalled();
  });
});
