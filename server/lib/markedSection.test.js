import { describe, it, expect } from 'vitest';
import {
  buildMarkers,
  replaceMarkedSection,
} from './markedSection.js';

const M = buildMarkers('activity-digest');

describe('buildMarkers', () => {
  it('produces a matched HTML-comment start/end pair from a stable id', () => {
    expect(M.start).toBe('<!-- portos:activity-digest:start -->');
    expect(M.end).toBe('<!-- portos:activity-digest:end -->');
  });

  it('falls back to a default id for empty/blank input', () => {
    expect(buildMarkers('').start).toBe('<!-- portos:section:start -->');
    expect(buildMarkers('   ').start).toBe('<!-- portos:section:start -->');
  });
});

describe('replaceMarkedSection', () => {
  it('inserts a section after existing user content, separated by a blank line', () => {
    const out = replaceMarkedSection('My hand-written notes.', 'AUTO BODY', M);
    expect(out).toBe(`My hand-written notes.\n\n${M.start}\nAUTO BODY\n${M.end}`);
  });

  it('inserts into empty content with no leading whitespace', () => {
    const out = replaceMarkedSection('', 'AUTO BODY', M);
    expect(out).toBe(`${M.start}\nAUTO BODY\n${M.end}`);
  });

  it('replaces ONLY the marked region and preserves surrounding user content', () => {
    const first = replaceMarkedSection('User text above.', 'FIRST', M);
    const second = replaceMarkedSection(`${first}\n\nUser text added below.`, 'SECOND', M);
    // The user text on both sides survives; only the body changed.
    expect(second).toContain('User text above.');
    expect(second).toContain('User text added below.');
    expect(second).toContain('SECOND');
    expect(second).not.toContain('FIRST');
    // Exactly one region.
    expect(second.match(new RegExp(M.start, 'g'))).toHaveLength(1);
    expect(second.match(new RegExp(M.end, 'g'))).toHaveLength(1);
  });

  it('is idempotent — replacing with the same body yields identical output', () => {
    const once = replaceMarkedSection('Notes.', 'SAME BODY', M);
    const twice = replaceMarkedSection(once, 'SAME BODY', M);
    expect(twice).toBe(once);
  });

  it('does not accumulate blank lines across repeated re-drafts', () => {
    let content = 'Notes.';
    for (let i = 0; i < 5; i++) content = replaceMarkedSection(content, `body ${i}`, M);
    expect(content).toBe(`Notes.\n\n${M.start}\nbody 4\n${M.end}`);
  });

  it('trims the body before embedding it', () => {
    const out = replaceMarkedSection('', '   padded body   \n', M);
    expect(out).toBe(`${M.start}\npadded body\n${M.end}`);
  });

  it('removes the region (and its leading blank line) when body is empty', () => {
    const withSection = replaceMarkedSection('Kept notes.', 'AUTO', M);
    const removed = replaceMarkedSection(withSection, '', M);
    expect(removed).toBe('Kept notes.');
  });

  it('returns content untouched when removing a section that is not present', () => {
    expect(replaceMarkedSection('Just notes.', '', M)).toBe('Just notes.');
  });

  it('does not swallow content between two different regions (non-greedy)', () => {
    const other = buildMarkers('other');
    let content = replaceMarkedSection('top', 'A', M);
    content = replaceMarkedSection(content, 'B', other);
    // Replacing M again must leave the `other` region intact.
    const out = replaceMarkedSection(content, 'A2', M);
    expect(out).toContain('A2');
    expect(out).toContain(`${other.start}\nB\n${other.end}`);
  });
});
