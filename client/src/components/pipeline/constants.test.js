import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { SEVERITY_COLORS, severityColor } from './constants.js';

const HERE = dirname(fileURLToPath(import.meta.url));

// Every pipeline surface that renders a severity-tagged finding card. These used
// to carry three byte-identical inline copies of the palette (#4109); the guard
// below fails if one of them grows a private copy again.
const CONSUMERS = [
  'SeriesReviewPanel.jsx',
  'AutopilotPanel.jsx',
  'arcCanvas/VerifyResults.jsx',
  'arcCanvas/CompletenessResults.jsx',
];

const readConsumer = (rel) => readFileSync(join(HERE, rel), 'utf8');

describe('pipeline severity palette', () => {
  it('exposes complete literal Tailwind class strings per severity', () => {
    // Literal, not interpolated — Tailwind scans source text, so an assembled
    // class name is silently dropped from the bundle.
    expect(SEVERITY_COLORS).toEqual({
      high: 'text-port-error border-port-error/40 bg-port-error/10',
      medium: 'text-port-warning border-port-warning/40 bg-port-warning/10',
      low: 'text-gray-400 border-gray-500/30 bg-gray-700/20',
    });
    for (const classes of Object.values(SEVERITY_COLORS)) {
      expect(classes).not.toMatch(/[`${}]/);
    }
  });

  it('resolves each known severity to its palette entry', () => {
    for (const [severity, classes] of Object.entries(SEVERITY_COLORS)) {
      expect(severityColor(severity)).toBe(classes);
    }
  });

  it('falls back to medium for absent, unknown, and prototype-key severities', () => {
    for (const severity of [undefined, null, '', 'critical', '__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
      expect(severityColor(severity)).toBe(SEVERITY_COLORS.medium);
    }
  });

  it.each(CONSUMERS)('%s renders the shared palette rather than a private copy', (rel) => {
    const src = readConsumer(rel);
    expect(src).toMatch(/import \{ severityColor \} from '\.{1,2}\/constants\.js'/);
    expect(src).toContain('severityColor(');
    // No local severity→class map, and no hand-inlined palette class strings.
    expect(src).not.toMatch(/(SEVERITY_STYLES|SEVERITY_COLORS)\s*=\s*\{/);
    expect(src).not.toContain(SEVERITY_COLORS.high);
    expect(src).not.toContain(SEVERITY_COLORS.medium);
    expect(src).not.toContain(SEVERITY_COLORS.low);
  });
});
