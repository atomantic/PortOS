import { describe, it, expect } from 'vitest';
import { fingerprintEntry, groupStderrEntries, templateSearchExcerpt } from './errorLogFingerprint.js';

// The redaction and template stages are reached through the one public entry
// point, as the triage service reaches them.
const redactLogText = (head, opts) => fingerprintEntry({ head, continuation: [] }, opts).excerpt;
const normalizeLogTemplate = (head) => fingerprintEntry({ head, continuation: [] }).template;

describe('redactLogText', () => {
  it.each([
    ['home path', 'read /Users/alice/code/app/x.json', 'alice', '/Users/<user>/code/app/x.json'],
    ['linux home path', 'open /home/alice/.config/x', 'alice', '/home/<user>/.config/x'],
    ['file URL stack frame', 'at f (file:///Users/alice/app/server/x.js:12:3)', 'alice', 'file:///Users/<user>/app/server/x.js'],
    ['tailnet host', 'peer host-1.example-tailnet.ts.net refused', 'host-1', '<host> refused'],
    ['mDNS host', 'dial studio.local failed', 'studio', '<host> failed'],
    ['IPv4', 'connect ECONNREFUSED 192.0.2.10:5432', '192.0.2.10', '<ip>'],
    ['UUID', 'record 123e4567-e89b-12d3-a456-426614174000 missing', '426614174000', 'record <uuid> missing'],
    ['email', 'notify alice@example.com', 'alice@', '<email>'],
    ['quoted record name', 'universe "Example Universe" failed', 'Example Universe', 'universe "<redacted>" failed'],
    ['bearer token', 'Authorization: Bearer abcdefghijklmnop1234567890', 'abcdefghijklmnop', '[REDACTED]'],
  ])('removes a %s', (_label, input, leaked, expected) => {
    const out = redactLogText(input);
    expect(out).not.toContain(leaked);
    expect(out).toContain(expected);
  });

  it('removes install literals as whole words only', () => {
    const out = redactLogText('mybox: sync with mybox-2 from myboxer', { extraTerms: ['mybox', 'x'] });
    expect(out).toBe('<redacted>: sync with mybox-2 from myboxer');
  });

  it('keeps identifiers an investigator needs', () => {
    expect(redactLogText("Cannot read properties of undefined (reading 'title')"))
      .toBe("Cannot read properties of undefined (reading 'title')");
  });
});

describe('normalizeLogTemplate', () => {
  it('collapses recurrences that differ only in volatile values', () => {
    const a = normalizeLogTemplate('❌ Task task-mvip9qsg failed after 1200ms at 2026-10-21T10:00:00Z (sha 1a2b3c4d5e) reading /Users/<user>/a/b.json');
    const b = normalizeLogTemplate('❌ Task task-zz81abcd failed after 35ms at 2026-10-22T11:30:00Z (sha 9f8e7d6c5b) reading /Users/<user>/c/d.json');
    expect(a).toBe(b);
    expect(a).toBe('❌ Task task-<id> failed after <n>ms at <time> (sha <sha>) reading <path>');
  });

  it('keeps API routes distinct so route errors do not merge', () => {
    expect(normalizeLogTemplate('❌ Route error [POST /api/cos/tasks]: boom'))
      .not.toBe(normalizeLogTemplate('❌ Route error [POST /api/brain/inbox]: boom'));
  });
});

describe('groupStderrEntries', () => {
  it('folds PM2-prefixed stack lines under their head line', () => {
    const entries = groupStderrEntries([
      '2026-10-21T15:44:59.800-07:00: ❌ Failed: boom',
      '2026-10-21T15:44:59.801-07:00:     at readFoo (/srv/app/x.js:1:1)',
      '',
      '2026-10-21T15:45:00.000-07:00: ⚠️ second fault',
    ].join('\n'));
    expect(entries).toEqual([
      { timestamp: '2026-10-21T22:44:59.800Z', head: '❌ Failed: boom', continuation: ['    at readFoo (/srv/app/x.js:1:1)'] },
      { timestamp: '2026-10-21T22:45:00.000Z', head: '⚠️ second fault', continuation: [] },
    ]);
  });
});

describe('templateSearchExcerpt', () => {
  it('picks the longest literal stretch and refuses a generic one', () => {
    expect(templateSearchExcerpt('❌ Route error [POST /api/x]: Checkout review refused: release-not-in-inventory'))
      .toBe('Checkout review refused: release-not-in-inventory');
    expect(templateSearchExcerpt('❌ Failed to read <path>')).toBeNull();
  });
});

describe('fingerprintEntry', () => {
  it('fingerprints the redacted head so private values never shape the key', () => {
    const one = fingerprintEntry({ head: '❌ Sync failed for "Alpha" on 192.0.2.10', continuation: [] });
    const two = fingerprintEntry({ head: '❌ Sync failed for "Beta" on 192.0.2.11', continuation: [] });
    expect(one.fingerprint).toBe(two.fingerprint);
    expect(one.excerpt).toBe('❌ Sync failed for "<redacted>" on <ip>');
  });
});
