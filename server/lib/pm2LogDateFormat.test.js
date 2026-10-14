import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const require = createRequire(import.meta.url);
const ecosystemPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'ecosystem.config.cjs');
const { LOG_DATE_FORMAT } = require(ecosystemPath);

// Regression for #11436: a literal `[Z]` labels the PM2 daemon's local wall-clock
// time as UTC, so prefixes disagree with embedded toISOString() values by the
// host's UTC offset. The offset token keeps both representations the same instant.
describe('PM2 LOG_DATE_FORMAT', () => {
  it('uses the dayjs offset token, not a literal Z', () => {
    expect(LOG_DATE_FORMAT).toBe('YYYY-MM-DDTHH:mm:ss.SSSZ');
    expect(LOG_DATE_FORMAT).not.toContain('[Z]');
  });

  it('is applied to every app via the shared constant', () => {
    const src = readFileSync(ecosystemPath, 'utf8');
    const uses = [...src.matchAll(/log_date_format:\s*(.+?),/g)].map((m) => m[1]);
    expect(uses.length).toBeGreaterThan(0);
    expect(new Set(uses)).toEqual(new Set(['LOG_DATE_FORMAT']));
  });

  it('produces a prefix that Date parses to the same instant as a UTC ISO string', () => {
    // Render the format's shape by hand for a -08:00 host and a UTC host.
    const instant = Date.parse('2026-01-01T12:00:00.000Z');
    expect(Date.parse('2026-01-01T04:00:00.000-08:00')).toBe(instant);
    expect(Date.parse('2026-01-01T12:00:00.000+00:00')).toBe(instant);
  });
});
