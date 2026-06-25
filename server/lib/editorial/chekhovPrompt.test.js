import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

import { applyTemplate } from '../promptTemplate.js';

// Renders the SHIPPED Chekhov stage prompt to pin the {{#distantGap}} toggle and
// the four-way taxonomy (#1595). A string-valued section (`distantGap: '6'`) is
// the same pattern as `{{#finalPart}}`/`{{#authoredSetups}}` — guard against a
// regression where the distant-payoff rule silently disappears or `{{distantGap}}`
// fails to interpolate inside its own section.
const CHEKHOV_PROMPT = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../../../data.reference/prompts/stages/pipeline-editorial-chekhov.md'),
  'utf-8',
);

const baseVars = (overrides = {}) => ({
  manuscript: '# Issue 1\n\nHe locked the revolver in the drawer.',
  authoredSetups: '',
  finalPart: 'true',
  distantGap: '6',
  ...overrides,
});

describe('pipeline-editorial-chekhov prompt rendering (#1595)', () => {
  it('renders the distant-payoff rule with the configured issue gap interpolated', () => {
    const out = applyTemplate(CHEKHOV_PROMPT, baseVars({ distantGap: '6' }));
    expect(out).toContain('distant payoff');
    // {{distantGap}} resolves inside its own {{#distantGap}} section.
    expect(out).toContain('6 or more issues after');
    expect(out).not.toContain('{{distantGap}}');
    expect(out).not.toContain('{{#distantGap}}');
  });

  it('omits the distant-payoff rule entirely when distantGap is the empty (disabled) var', () => {
    const out = applyTemplate(CHEKHOV_PROMPT, baseVars({ distantGap: '' }));
    expect(out).not.toContain('distant payoff');
    expect(out).not.toMatch(/distant payoffs/);
    // The other two failure modes still render.
    expect(out).toContain('false setup');
    expect(out).toContain('orphaned payoff');
    expect(out).not.toContain('{{#distantGap}}');
  });

  it('always renders the false-setup and orphaned-payoff classes regardless of distantGap', () => {
    for (const gap of ['', '1', '4', '20']) {
      const out = applyTemplate(CHEKHOV_PROMPT, baseVars({ distantGap: gap }));
      expect(out).toContain('false setup');
      expect(out).toContain('orphaned payoff');
      expect(out).toContain('paired');
    }
  });

  it('leaves no unresolved mustache tags for a fully-populated context', () => {
    const out = applyTemplate(CHEKHOV_PROMPT, baseVars({
      authoredSetups: '- Hook: the locked drawer (Issue 1)',
    }));
    expect(out).not.toMatch(/\{\{[#^/]?[\w.]+\}\}/);
  });
});
