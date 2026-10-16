import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { GOOGLE_API_TIMEOUT_MS } from './googleAuth.js';

const serviceFiles = [
  'messageGmailSync.js',
  'messageActions.js',
  'calendarGoogleApiSync.js',
  'goalCalendarScheduler.js',
];

describe('Google API client request timeout', () => {
  it('sets the shared deadline on every Gmail and Calendar service client', () => {
    const constructors = serviceFiles.flatMap(file => {
      const source = readFileSync(new URL(`./${file}`, import.meta.url), 'utf8');
      return [...source.matchAll(/\b(?:gmail|calendar)\(\s*\{[^}]*\}\s*\)/gs)]
        .map(([construction]) => ({ file, construction }));
    });

    expect(GOOGLE_API_TIMEOUT_MS).toBe(30_000);
    expect(constructors).toHaveLength(8);
    for (const { file, construction } of constructors) {
      expect(construction, file).toContain('timeout: GOOGLE_API_TIMEOUT_MS');
    }
  });

  it('keeps the shorter Gmail reply-metadata request override', () => {
    const source = readFileSync(new URL('./messageGmailSync.js', import.meta.url), 'utf8');
    expect(source).toMatch(/metadata\s*=\s*await gmailClient\.users\.messages\.get\([\s\S]*?\},\s*\{ timeout: 10_000, retry: false \}\)/);
  });
});
