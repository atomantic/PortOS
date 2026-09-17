/**
 * The composite provider-id grammar exists in two places by architecture — the
 * vendored `aiToolkit/` may not import out of its own directory, so it carries
 * its own copy. This pins the two together, as the gateway and harness parity
 * suites do, so the toolkit can never read a reference differently from the
 * host that resolves it.
 */
import { describe, expect, it } from 'vitest';
import * as server from './providerRef.js';
import * as toolkit from './aiToolkit/internal/providerRef.js';

const SAMPLES = [
  'claude-code', 'pi.tui@nvidia-nim-free', 'direct.api@ollama', 'claude.cli@anthropic+corp-auth',
  'pi.tui@Nvidia', 'pi.tui@', 'pi.gui@x', 'direct.api@ollama+corp-auth', '', 'x'.repeat(201),
];

describe('providerRef ↔ aiToolkit/internal/providerRef parity', () => {
  it('compiles the same regexes and length bound', () => {
    expect(toolkit.PRESET_ID_RE.source).toBe(server.PRESET_ID_RE.source);
    expect(toolkit.COMPOSITE_ID_RE.source).toBe(server.COMPOSITE_ID_RE.source);
    expect(toolkit.MAX_PROVIDER_REF_LENGTH).toBe(server.MAX_PROVIDER_REF_LENGTH);
    expect(toolkit.PRESET_ONLY_MESSAGE).toBe(server.PRESET_ONLY_MESSAGE);
  });

  it.each(SAMPLES)('parses %j identically', (id) => {
    expect(toolkit.parseProviderRef(id)).toEqual(server.parseProviderRef(id));
    expect(toolkit.isCompositeProviderId(id)).toBe(server.isCompositeProviderId(id));
  });
});
