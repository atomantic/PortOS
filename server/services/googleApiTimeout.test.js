import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { GOOGLE_API_TIMEOUT_MS } from './googleAuth.js';

const serviceFiles = [
  'calendarGoogleApiSync.js',
  'goalCalendarScheduler.js',
];

describe('Google API client request timeout', () => {
  it('sets the shared deadline on every Calendar service client (Gmail goes through gmailApi.js)', () => {
    const constructors = serviceFiles.flatMap(file => {
      const source = readFileSync(new URL(`./${file}`, import.meta.url), 'utf8');
      return [...source.matchAll(/\bcalendar\(\s*\{[^}]*\}\s*\)/gs)]
        .map(([construction]) => ({ file, construction }));
    });

    expect(GOOGLE_API_TIMEOUT_MS).toBe(30_000);
    expect(constructors).toHaveLength(4);
    for (const { file, construction } of constructors) {
      expect(construction, file).toContain('timeout: GOOGLE_API_TIMEOUT_MS');
    }
  });

  it('keeps the shorter Gmail reply-metadata request override', () => {
    const source = readFileSync(new URL('./messageGmailSync.js', import.meta.url), 'utf8');
    expect(source).toMatch(/gmailClient\.getMessage\([\s\S]*?\},\s*\{ timeout: 10_000, retry: false \}\)/);
  });
});
