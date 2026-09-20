/**
 * The act-warning message has one job beyond reporting the component: when a
 * leaked setState is caught by a LATER test's afterEach, it must send the
 * reader to the test that leaked — not to the one that happened to catch it.
 * That misattribution cost a CI bisect on #7785, so it is pinned here.
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
  it('points at the leaking test when another test caught the warning', () => {
    const message = formatActWarningError(
      [actWarningEntry('AttachmentMirrorCard', 'mounts the panel')],
      'keeps Save token disabled until something is typed',
    );
    expect(message).toContain('AttachmentMirrorCard (leaked from: mounts the panel)');
    expect(message).toContain('fix it there, not here');
    expect(message).toContain('"keeps Save token disabled until something is typed"');
  });

  it('does not cry misattribution when the leak is in the catching test', () => {
    const message = formatActWarningError(
      [actWarningEntry('AttachmentMirrorCard', 'mounts the panel')],
      'mounts the panel',
    );
    expect(message).toContain('AttachmentMirrorCard');
    expect(message).not.toContain('leaked from');
    expect(message).not.toContain('fix it there, not here');
  });

  it('treats a warning that fired between tests as belonging to the catcher', () => {
    // `currentTestName` is null outside a test body; with no origin to name,
    // claiming it escaped somewhere else would be a guess.
    const message = formatActWarningError([actWarningEntry('Card', null)], 'some test');
    expect(message).not.toContain('leaked from');
  });

  it('dedupes repeats but keeps two origins of the same component apart', () => {
    const message = formatActWarningError([
      actWarningEntry('Card', 'test A'),
      actWarningEntry('Card', 'test A'),
      actWarningEntry('Card', 'test B'),
    ], 'test C');
    expect(message).toContain('Card (leaked from: test A)');
    expect(message).toContain('Card (leaked from: test B)');
    expect(message.match(/leaked from: test A/g)).toHaveLength(1);
  });

  it('always carries the remedy', () => {
    const message = formatActWarningError([actWarningEntry('Card', 'test A')], 'test A');
    expect(message).toContain('await act(async () => {})');
  });
});
