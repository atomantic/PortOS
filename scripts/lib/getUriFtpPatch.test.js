import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { createRequire } from 'module';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  applyGetUriFtpPatch,
  parseUnixListDate,
  patchFingerprint
} from './getUriFtpPatch.js';

const NOW = Date.UTC(2026, 9, 1, 12, 0); // 2026-10-01T12:00Z
const iso = raw => parseUnixListDate(raw, NOW).toISOString();

describe('parseUnixListDate (basic-ftp rawModifiedAt contract, read as UTC)', () => {
  it.each([
    ['Jan 1 2020', '2020-01-01T00:00:00.000Z'],
    ['1 Jan 2020', '2020-01-01T00:00:00.000Z'],
    ['sep 09 2019', '2019-09-09T00:00:00.000Z'],
    ['2020-01-02 03:04', '2020-01-02T03:04:00.000Z'],
    ['2020/1/2 3:04', '2020-01-02T03:04:00.000Z'],
    ['Aug 15 08:30', '2026-08-15T08:30:00.000Z'],
    ['15 Aug 08:30', '2026-08-15T08:30:00.000Z']
  ])('parses %s', (raw, expected) => {
    expect(iso(raw)).toBe(expected);
  });

  it('resolves a year-less date to the latest year not beyond one day ahead', () => {
    expect(iso('Oct 1 11:59')).toBe('2026-10-01T11:59:00.000Z'); // earlier today
    expect(iso('Oct 2 11:00')).toBe('2026-10-02T11:00:00.000Z'); // within the skew tolerance
    expect(iso('Oct 3 00:00')).toBe('2025-10-03T00:00:00.000Z'); // beyond it: last year
    expect(iso('Dec 25 10:00')).toBe('2025-12-25T10:00:00.000Z');
  });

  it('finds the latest leap year for a year-less Feb 29', () => {
    expect(iso('Feb 29 10:00')).toBe('2024-02-29T10:00:00.000Z');
  });

  it.each([
    ['empty', ''],
    ['non-English month', 'Okt 1 2020'],
    ['Japanese form', '10月01日 2020年'],
    ['impossible day', 'Feb 30 2020'],
    ['impossible time', 'Jan 1 24:00'],
    ['ambiguous day-first numeric date', '01-02-2020 10:00'],
    ['trailing text', 'Jan 1 2020 extra']
  ])('refuses %s instead of inventing a timestamp', (_name, raw) => {
    expect(() => parseUnixListDate(raw, NOW)).toThrowError(expect.objectContaining({ code: 'EFTPLISTDATE' }));
  });
});

describe('applyGetUriFtpPatch', () => {
  const dirs = [];
  afterEach(() => dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })));

  // Reduced to the line the patch edits, plus the declaration it anchors on.
  const UPSTREAM = [
    '"use strict";',
    'const ftp = (entry) => {',
    '    let lastModified;',
    '    if (entry) {',
    '        lastModified = entry.modifiedAt;',
    '    }',
    '    return lastModified;',
    '};',
    'exports.ftp = ftp;',
    ''
  ].join('\n');

  const install = (source = UPSTREAM) => {
    const nodeModules = mkdtempSync(join(tmpdir(), 'get-uri-patch-'));
    dirs.push(nodeModules);
    mkdirSync(join(nodeModules, 'get-uri', 'dist'), { recursive: true });
    writeFileSync(join(nodeModules, 'get-uri', 'dist', 'ftp.js'), source);
    return nodeModules;
  };

  it('prefers MLSD/MDTM metadata and falls back to the parsed LIST date', () => {
    const nodeModules = install();
    expect(applyGetUriFtpPatch(nodeModules)).toBe('patched');
    const { ftp } = createRequire(import.meta.url)(join(nodeModules, 'get-uri', 'dist', 'ftp.js'));
    expect(ftp({ modifiedAt: new Date(0), rawModifiedAt: 'Jan 1 2020' })).toEqual(new Date(0));
    expect(ftp({ rawModifiedAt: 'Jan 1 2020' })).toEqual(new Date('2020-01-01T00:00:00Z'));
    expect(() => ftp({ rawModifiedAt: '' })).toThrowError(expect.objectContaining({ code: 'EFTPLISTDATE' }));
  });

  it('is idempotent', () => {
    const nodeModules = install();
    applyGetUriFtpPatch(nodeModules);
    const once = readFileSync(join(nodeModules, 'get-uri', 'dist', 'ftp.js'), 'utf8');
    expect(applyGetUriFtpPatch(nodeModules)).toBe('already-patched');
    expect(readFileSync(join(nodeModules, 'get-uri', 'dist', 'ftp.js'), 'utf8')).toBe(once);
    expect(once.match(/portos-patch #9462 begin/g)).toHaveLength(1);
  });

  it('replaces an older injected patch instead of keeping or stacking it', () => {
    const nodeModules = install();
    applyGetUriFtpPatch(nodeModules);
    const file = join(nodeModules, 'get-uri', 'dist', 'ftp.js');
    const current = readFileSync(file, 'utf8');
    // Simulate a tree patched by an earlier release of this patch.
    writeFileSync(file, current
      .replace(/begin [0-9a-f]{16}/, 'begin 0000000000000000')
      .replace(/function parseUnixListDate[\s\S]*?\n}\n/, 'function parseUnixListDate() { return new Date(0); }\n'));
    expect(applyGetUriFtpPatch(nodeModules)).toBe('patched');
    expect(readFileSync(file, 'utf8')).toBe(current);
  });

  it('reports a missing install and never edits a get-uri it does not recognize', () => {
    expect(applyGetUriFtpPatch(mkdtempSync(join(tmpdir(), 'get-uri-empty-')))).toBe('absent');
    const foreign = 'module.exports = { ftp() { return entry.lastModified; } };\n';
    const nodeModules = install(foreign);
    expect(applyGetUriFtpPatch(nodeModules)).toBe('unrecognized');
    expect(readFileSync(join(nodeModules, 'get-uri', 'dist', 'ftp.js'), 'utf8')).toBe(foreign);
  });

  it('exposes a stable fingerprint so a cached node_modules tree can be invalidated', () => {
    expect(patchFingerprint()).toMatch(/^[0-9a-f]{16}$/);
    expect(patchFingerprint()).toBe(patchFingerprint());
  });
});
