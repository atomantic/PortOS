/**
 * Focused tests for the pure Telegram message builder.
 *
 * The transports' own suites drive `buildNotificationMessage` through
 * `forwardNotification` end-to-end. What an integration test would NOT localise
 * is the truncate-then-escape ORDERING: slicing already-escaped text can cut an
 * HTML entity in half (`&am`), which Telegram renders as broken markup rather
 * than rejecting outright — a silent corruption, not a visible failure.
 *
 * The emoji-map parity check lives here too: the map is keyed by literal type
 * strings so the module stays a dependency-free leaf, and this pins those keys
 * to the real `NOTIFICATION_TYPES` enum.
 */

import { describe, it, expect } from 'vitest';
import {
  buildNotificationMessage,
  escapeHtml,
  truncateForTelegram,
  NOTIFICATION_EMOJI,
  TELEGRAM_MAX_RAW_CHARS,
  CALLBACK_APPROVE,
  CALLBACK_REJECT
} from './telegramMessage.js';
import { NOTIFICATION_TYPES } from '../services/notifications.js';

describe('telegramMessage', () => {
  describe('truncate/escape ordering', () => {
    it('truncates the RAW body before escaping so a slice cannot split an entity', () => {
      // Land an `&` exactly on the cut so escaping first would leave `&am`.
      const body = `${'a'.repeat(TELEGRAM_MAX_RAW_CHARS - 1)}&${'b'.repeat(50)}`;
      const { text } = buildNotificationMessage({ type: 'health_issue', title: 'T', description: body });

      const line = text.split('\n')[1];
      expect(line.endsWith('&amp;…')).toBe(true);
      expect(line).not.toMatch(/&(?!amp;|lt;|gt;)/);
    });

    it('appends the ellipsis only when the cap actually bites', () => {
      const exact = 'x'.repeat(TELEGRAM_MAX_RAW_CHARS);
      expect(truncateForTelegram(exact)).toBe(exact);
      expect(truncateForTelegram(`${exact}y`)).toBe(`${exact}…`);
    });

    it('escapes every markup character Telegram HTML mode would interpret', () => {
      expect(escapeHtml('a & b <i>c</i>')).toBe('a &amp; b &lt;i&gt;c&lt;/i&gt;');
      expect(escapeHtml('')).toBe('');
      expect(escapeHtml(undefined)).toBe('');
    });
  });

  describe('memory approval', () => {
    it('prefers the resolved approval body over the description and attaches the keyboard', () => {
      const { text, options } = buildNotificationMessage(
        {
          type: NOTIFICATION_TYPES.MEMORY_APPROVAL,
          title: 'New memory',
          description: 'fallback text',
          priority: 'high',
          metadata: { memoryId: 'mem-1' }
        },
        { approvalBody: 'the memory summary' }
      );

      expect(text).toContain('the memory summary');
      expect(text).not.toContain('fallback text');
      expect(options.reply_markup.inline_keyboard[0].map(b => b.callback_data)).toEqual([
        `${CALLBACK_APPROVE}:mem-1`,
        `${CALLBACK_REJECT}:mem-1`
      ]);
    });

    it('carries no keyboard when the approval notification has no memoryId', () => {
      const { options } = buildNotificationMessage({
        type: NOTIFICATION_TYPES.MEMORY_APPROVAL,
        title: 'Orphan',
        metadata: {}
      });
      expect(options).toEqual({ parse_mode: 'HTML' });
    });
  });

  it('keys the emoji map by real NOTIFICATION_TYPES values', () => {
    const known = new Set(Object.values(NOTIFICATION_TYPES));
    expect(Object.keys(NOTIFICATION_EMOJI).filter(k => !known.has(k))).toEqual([]);
  });
});
