import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';
import {
  ALL_ALLOWED_TAGS, decodeHtmlEntities, messagePreviewText, parseMessageBody,
} from './beeperMessageBody';

const MODULE_FILE = join(dirname(fileURLToPath(import.meta.url)), 'beeperMessageBody.js');

/**
 * #35 real-browser pass (#59): a message body containing an ampersand rendered
 * as the five-character HTML entity `&amp;` in the thread bubble. Beeper
 * Desktop delivers entity-encoded text for some bridged networks; PortOS itself
 * never escapes on the way in (`beeperSync.js` `normalizeMessageRow` passes
 * `message.text` through unchanged), so decoding belongs on the way out to the
 * DOM — as a plain text node, never `dangerouslySetInnerHTML`.
 */
describe('decodeHtmlEntities', () => {
  it('decodes the five predefined named entities', () => {
    expect(decodeHtmlEntities('&amp;')).toBe('&');
    expect(decodeHtmlEntities('&lt;')).toBe('<');
    expect(decodeHtmlEntities('&gt;')).toBe('>');
    expect(decodeHtmlEntities('&quot;')).toBe('"');
    expect(decodeHtmlEntities('&#39;')).toBe("'");
  });

  it('decodes a realistic sentence with an ampersand', () => {
    expect(decodeHtmlEntities('salt &amp; pepper')).toBe('salt & pepper');
  });

  it('decodes &nbsp; to a non-breaking space, the one entity beyond the server five', () => {
    expect(decodeHtmlEntities('one&nbsp;two')).toBe('one\u00a0two');
  });

  it('leaves a plain string with no entities untouched', () => {
    expect(decodeHtmlEntities('no entities here')).toBe('no entities here');
  });

  it('is double-decode-safe: &amp;lt; decodes to &lt;, never <', () => {
    expect(decodeHtmlEntities('&amp;lt;')).toBe('&lt;');
  });

  it('leaves an unknown named entity and an out-of-range numeric ref untouched', () => {
    expect(decodeHtmlEntities('&zzz;')).toBe('&zzz;');
    expect(decodeHtmlEntities('&#99999999;')).toBe('&#99999999;');
  });

  it('does not resolve inherited Object.prototype properties as entities', () => {
    // Untrusted remote chat text can contain literally anything. A lookup that
    // walks the prototype chain renders `&constructor;` as a stringified
    // built-in instead of leaving it alone.
    expect(decodeHtmlEntities('&constructor;')).toBe('&constructor;');
    expect(decodeHtmlEntities('&toString;')).toBe('&toString;');
    expect(decodeHtmlEntities('&hasOwnProperty;')).toBe('&hasOwnProperty;');
  });

  it('passes through non-string and empty input unchanged', () => {
    expect(decodeHtmlEntities(undefined)).toBe(undefined);
    expect(decodeHtmlEntities(null)).toBe(null);
    expect(decodeHtmlEntities('')).toBe('');
  });
});

/**
 * The final live pass: 26% of message bodies on a real install are HTML
 * (Discord and Matrix), and the mirror stores what the source sent — so the
 * thread and the rail preview showed the tags literally.
 */
describe('parseMessageBody', () => {
  const textOf = (blocks) => blocks.map((b) => b.spans.map((s) => s.text).join('')).join('\n');

  it('answers null for a plain body, so the caller keeps its text-node path', () => {
    expect(parseMessageBody('just a message')).toBeNull();
    expect(parseMessageBody('salt &amp; pepper')).toBeNull();
    // A comparison and an emoticon are not markup.
    expect(parseMessageBody('5 < 6 and <3')).toBeNull();
    expect(parseMessageBody('')).toBeNull();
    expect(parseMessageBody(null)).toBeNull();
  });

  it('splits paragraphs into blocks and keeps <br> as a line break inside one', () => {
    expect(textOf(parseMessageBody('<p>first</p><p>second<br>third</p>')))
      .toBe('first\nsecond\nthird');
  });

  it('marks bold and italic spans without losing the surrounding text', () => {
    const [block] = parseMessageBody('<p>plain <strong>bold</strong> and <em>italic</em></p>');
    expect(block.spans).toEqual([
      { text: 'plain ', bold: false, italic: false, href: null },
      { text: 'bold', bold: true, italic: false, href: null },
      { text: ' and ', bold: false, italic: false, href: null },
      { text: 'italic', bold: false, italic: true, href: null },
    ]);
  });

  it('keeps an http(s) link and drops a scheme that is not one', () => {
    const [ok] = parseMessageBody('<p>see <a href="https://example.com/x">this</a></p>');
    expect(ok.spans.find((span) => span.text === 'this').href).toBe('https://example.com/x');

    // A `javascript:` href becomes plain text rather than a clickable link.
    const [bad] = parseMessageBody('<p><a href="javascript:alert(1)">click</a></p>');
    expect(bad.spans).toEqual([{ text: 'click', bold: false, italic: false, href: null }]);
  });

  it('renders a blockquote as its own quote block', () => {
    const blocks = parseMessageBody('<blockquote>quoted line</blockquote><p>reply</p>');
    expect(blocks.map((block) => block.type)).toEqual(['quote', 'paragraph']);
    expect(textOf(blocks)).toBe('quoted line\nreply');
  });

  it('drops a tag outside the allowlist but keeps its text', () => {
    // No allowlisted tag can execute, load or style anything, because nothing
    // here is ever handed to `dangerouslySetInnerHTML` — an unknown tag simply
    // contributes its text.
    expect(textOf(parseMessageBody('<p>before<script>alert(1)</script>after</p>')))
      .toBe('beforealert(1)after');
    expect(textOf(parseMessageBody('<p>an <img src="x" onerror="alert(1)"> image</p>')))
      .toBe('an  image');
  });

  it('decodes entities inside an HTML body, and only after the tags are split off', () => {
    // `&lt;b&gt;` is text the sender typed, not a tag — it must survive as text.
    expect(textOf(parseMessageBody('<p>salt &amp; pepper &lt;b&gt;</p>')))
      .toBe('salt & pepper <b>');
  });

  it('survives unbalanced markup rather than swallowing the rest of the message', () => {
    expect(textOf(parseMessageBody('<p>open <strong>bold</p><p>next</p>')))
      .toBe('open bold\nnext');
    expect(textOf(parseMessageBody('</strong></blockquote><p>still here</p>')))
      .toBe('still here');
  });

  it('returns no blocks for an HTML body with no text at all', () => {
    expect(parseMessageBody('<p></p>')).toEqual([]);
  });
});

/**
 * Pins the module docblock's allowlist sentence to the tag set the parser
 * actually dispatches on, so the two cannot drift apart again the way they
 * did when `div` joined BLOCK_TAGS without the sentence naming it (audit
 * cluster 10, finding F10).
 */
describe('docblock allowlist', () => {
  it('names exactly the tags the parser treats as meaningful', () => {
    const source = readFileSync(MODULE_FILE, 'utf8');
    const sentence = source.match(/The allowlist is exactly what was observed:([^.]*)\./);
    expect(sentence).not.toBeNull();
    const namedTags = new Set(
      [...sentence[1].matchAll(/`([^`]+)`/g)]
        .flatMap((match) => match[1].split('/'))
        .map((tag) => tag.replace(/\[.*\]$/, '')),
    );
    expect(namedTags).toEqual(ALL_ALLOWED_TAGS);
  });
});

describe('messagePreviewText', () => {
  it('flattens an HTML body to one line for the rail row', () => {
    expect(messagePreviewText('<p>first</p><p>second<br>third</p>')).toBe('first second third');
  });

  it('keeps a quote marker so a reply preview still reads as a reply', () => {
    expect(messagePreviewText('<blockquote>them</blockquote><p>me</p>')).toBe('> them me');
  });

  it('leaves a plain body to the entity decoder alone', () => {
    expect(messagePreviewText('salt &amp; pepper')).toBe('salt & pepper');
    expect(messagePreviewText('')).toBe('');
  });
});
