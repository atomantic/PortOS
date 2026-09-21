/**
 * The act-warning diagnostic distinguishes the test active when a warning
 * fires from the test whose afterEach reports it. Neither proves where the
 * asynchronous work began.
 */
import { describe, it, expect } from 'vitest';
import { actWarningEntry, formatActWarningError } from './actWarnings.js';

describe('actWarningEntry', () => {
  it('keeps the component and the test that was running', () => {
    expect(actWarningEntry('AttachmentMirrorCard', 'renders the mirror')).toEqual({
      component: 'AttachmentMirrorCard', test: 'renders the mirror',
    });
  });

  it('survives React naming nothing, and a warning that fired between tests', () => {
    expect(actWarningEntry(undefined, undefined)).toEqual({ component: 'unknown component', test: null });
  });
});

describe('formatActWarningError', () => {
  it('names observation and detection without claiming an asynchronous origin', () => {
    const message = formatActWarningError(
      [actWarningEntry('AttachmentMirrorCard', 'mounts the panel')],
      'keeps Save token disabled until something is typed',
    );
    expect(message).toContain('AttachmentMirrorCard (warning observed during: mounts the panel)');
    expect(message).toContain('asynchronous work may have started in an earlier test');
    expect(message).not.toContain('leaked from');
    expect(message).not.toContain('fix it there, not here');
    expect(message).toContain('"keeps Save token disabled until something is typed"');
  });

  it('still avoids claiming an origin when observation and detection share a test', () => {
    const message = formatActWarningError(
      [actWarningEntry('AttachmentMirrorCard', 'mounts the panel')],
      'mounts the panel',
    );
    expect(message).toContain('AttachmentMirrorCard');
    expect(message).not.toContain('leaked from');
    expect(message).not.toContain('fix it there, not here');
  });

  it('does not invent an observation test for a warning captured between tests', () => {
    // `currentTestName` is null outside a test body; with no origin to name,
    // claiming it escaped somewhere else would be a guess.
    const message = formatActWarningError([actWarningEntry('Card', null)], 'some test');
    expect(message).not.toContain('leaked from');
    expect(message).not.toContain('warning observed during:');
  });

  it('dedupes repeats but keeps two observation contexts of the same component apart', () => {
    const message = formatActWarningError([
      actWarningEntry('Card', 'test A'),
      actWarningEntry('Card', 'test A'),
      actWarningEntry('Card', 'test B'),
    ], 'test C');
    expect(message).toContain('Card (warning observed during: test A)');
    expect(message).toContain('Card (warning observed during: test B)');
    expect(message.match(/warning observed during: test A/g)).toHaveLength(1);
  });

  it('always carries the remedy', () => {
    const message = formatActWarningError([actWarningEntry('Card', 'test A')], 'test A');
    expect(message).toContain('await act(async () => {})');
  });
});
