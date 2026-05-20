import { describe, it, expect } from 'vitest';
import { stripAnsi, createStreamingAnsiStripper, ANSI_PATTERN } from './ansiStrip.js';

// These tests pin the *current* behavior of the streaming stripper. Anything
// surprising (e.g. OSC bodies leaking because `[@-Z\\-_]` matches `\x1B]`
// before the OSC alternative can fire) is called out inline so a future
// regex rewrite has explicit before/after evidence to work against.

describe('stripAnsi (one-shot)', () => {
  it('returns empty string for non-string input', () => {
    expect(stripAnsi(null)).toBe('');
    expect(stripAnsi(undefined)).toBe('');
    expect(stripAnsi(42)).toBe('');
    expect(stripAnsi({})).toBe('');
    expect(stripAnsi([])).toBe('');
  });

  it('passes plain text through unchanged', () => {
    expect(stripAnsi('hello world')).toBe('hello world');
    expect(stripAnsi('line1\nline2\tcol2')).toBe('line1\nline2\tcol2');
  });

  it('strips a complete CSI sequence', () => {
    expect(stripAnsi('\x1B[2Jcleared')).toBe('cleared');
    expect(stripAnsi('\x1B[31mred\x1B[0m')).toBe('red');
    expect(stripAnsi('\x1B[1;31;47mfoo\x1B[0m')).toBe('foo');
  });

  it('strips the `\\x1B]` OSC opener but leaves the body when BEL-terminated', () => {
    // The OSC alternative in ANSI_PATTERN is unreachable because the
    // single-byte alternative `[@-Z\\-_]` matches `]` (0x5D) first. So an
    // OSC sequence loses its `\x1B]` prefix and keeps the body+BEL. This is
    // a latent bug — callers in tuiPromptRunner/agentTuiSpawning consume
    // the result as-is. Documented here so a future fix has a baseline.
    expect(stripAnsi('\x1B]0;title\x07after')).toBe('0;title\x07after');
  });

  it('strips both `\\x1B]` opener AND `\\x1B\\\\` ST terminator when OSC is ST-terminated', () => {
    // Same alt-order quirk strips `\x1B\\` (backslash, 0x5C, in 0x5C-0x5F),
    // so the body remains but both ESC bytes vanish.
    expect(stripAnsi('\x1B]0;title\x1B\\after')).toBe('0;titleafter');
  });

  it('strips a bare `\\x1B]` (single-byte path) when nothing follows', () => {
    expect(stripAnsi('a\x1B]b')).toBe('ab');
  });

  it('strips single-byte escape forms (\\x1B@ ... \\x1B_)', () => {
    expect(stripAnsi('a\x1B@b')).toBe('ab');
    expect(stripAnsi('a\x1BDb')).toBe('ab');
    expect(stripAnsi('a\x1B_b')).toBe('ab');
  });

  it('strips a bare \\x1B not followed by 0x40-0x5F (lookahead branch)', () => {
    // `(` is 0x28, not in [@-_], so the bare-ESC catch-all fires and only
    // the ESC is removed.
    expect(stripAnsi('\x1B(plain')).toBe('(plain');
  });

  it('strips NUL bytes', () => {
    expect(stripAnsi('a\x00b\x00c')).toBe('abc');
  });

  it('handles mixed content in one pass', () => {
    expect(stripAnsi('\x1B[2J\x1B[Hhi\x00\x1B[31mthere\x1B[0m')).toBe('hithere');
  });

  it('exports an ANSI_PATTERN regex that matches CSI starts', () => {
    expect(ANSI_PATTERN).toBeInstanceOf(RegExp);
    expect('\x1B[31m'.replace(ANSI_PATTERN, '')).toBe('');
  });
});

describe('createStreamingAnsiStripper', () => {
  it('returns independent stateful stripper instances', () => {
    const a = createStreamingAnsiStripper();
    const b = createStreamingAnsiStripper();
    // Feed an incomplete escape into A only; B should still pass plain text through.
    a('hi\x1B[');
    expect(b('hello')).toBe('hello');
    // A continues to buffer until the sequence completes.
    expect(a('31mworld')).toBe('world');
  });

  it('passes clean text through unchanged minus NUL', () => {
    const strip = createStreamingAnsiStripper();
    expect(strip('hello\nworld\x00')).toBe('hello\nworld');
  });

  it('resolves a CSI sequence split across two chunks', () => {
    const strip = createStreamingAnsiStripper();
    expect(strip('hi\x1B[')).toBe('hi');
    expect(strip('31mworld')).toBe('world');
  });

  it('resolves a CSI sequence split with parameter bytes already in chunk1', () => {
    // `\x1B[01;` is still incomplete (no final byte yet); chunk2 closes it.
    const strip = createStreamingAnsiStripper();
    expect(strip('pre\x1B[01;')).toBe('pre');
    expect(strip('33mtext')).toBe('text');
  });

  it('buffers a bare \\x1B at chunk end and resolves on the next chunk', () => {
    const strip = createStreamingAnsiStripper();
    // Bare ESC could become a CSI/OSC/single-byte escape — must buffer.
    expect(strip('abc\x1B')).toBe('abc');
    // Next chunk completes a single-byte escape form (`\x1B@`).
    expect(strip('@xyz')).toBe('xyz');
  });

  it('buffers a bare \\x1B at chunk end and resolves into a CSI on the next chunk', () => {
    const strip = createStreamingAnsiStripper();
    expect(strip('abc\x1B')).toBe('abc');
    expect(strip('[2Jxyz')).toBe('xyz');
  });

  it('buffers an OSC opener split across chunks (BEL terminator) — body still leaks on flush', () => {
    // Streaming correctly *defers* the chunk boundary inside an OSC opener
    // — the trailing `\x1B]0;ti` is held until the next chunk arrives. But
    // when the terminator chunk lands and the full sequence is re-strip'd,
    // the regex's dead OSC alternative means only `\x1B]` is consumed and
    // the `0;title\x07` body leaks. Future-fix baseline.
    const strip = createStreamingAnsiStripper();
    expect(strip('pre\x1B]0;ti')).toBe('pre');
    expect(strip('tle\x07post')).toBe('0;title\x07post');
  });

  it('buffers an OSC opener split across three chunks then leaks the body', () => {
    const strip = createStreamingAnsiStripper();
    expect(strip('A\x1B]')).toBe('A');
    expect(strip('8;;https://example.com')).toBe('');
    // BEL terminator survives because the OSC alternative is dead — only
    // the `\x1B]` prefix is consumed, body+BEL stay.
    expect(strip('\x07Z')).toBe('8;;https://example.com\x07Z');
  });

  it('does NOT buffer an OSC body longer than 4096 bytes — it leaks instead of pinning memory', () => {
    const strip = createStreamingAnsiStripper();
    // OSC opens, then 4097 chars of body with no terminator. The 4096-byte
    // window guard (`combined.length - lastEsc <= 4096`) is exceeded so we
    // fall through to STRIP without buffering. Body leaks rather than
    // pinning memory waiting for a terminator that may never come.
    const longBody = 'x'.repeat(4097);
    const out = strip(`\x1B]0;${longBody}`);
    expect(out).toContain(longBody);
    // No tail held over — the next chunk is uncorrupted.
    expect(strip('next')).toBe('next');
  });

  it('treats an older unterminated ESC as resolved when newer plain text pushes it past the 4096-byte window', () => {
    const strip = createStreamingAnsiStripper();
    // A bare `\x1B` followed by enough plain text that lastEsc lives outside
    // the 4096-byte trailing window. The buffer-candidate branch is skipped
    // and we fall through to STRIP. The bare-ESC lookahead branch removes
    // the lone `\x1B` (since `y` is 0x79, not in [@-_]) leaving plain text.
    const padding = 'y'.repeat(5000);
    expect(strip(`\x1B${padding}`)).toBe(padding);
    // Nothing held over.
    expect(strip('done')).toBe('done');
  });

  it('flushes completed sequences while buffering a trailing incomplete one', () => {
    const strip = createStreamingAnsiStripper();
    // First chunk: one completed CSI + a trailing incomplete CSI.
    expect(strip('\x1B[31mhi\x1B[')).toBe('hi');
    // Trailer closes — buffered fragment merges and gets stripped.
    expect(strip('32mthere')).toBe('there');
  });

  it('handles consecutive complete chunks independently', () => {
    const strip = createStreamingAnsiStripper();
    expect(strip('\x1B[31mfoo\x1B[0m')).toBe('foo');
    expect(strip('\x1B[32mbar\x1B[0m')).toBe('bar');
  });

  it('safely handles an empty chunk', () => {
    const strip = createStreamingAnsiStripper();
    expect(strip('')).toBe('');
    // Then a normal chunk still works.
    expect(strip('plain')).toBe('plain');
  });

  it('does not corrupt the next chunk after a clean (no-tail) flush', () => {
    const strip = createStreamingAnsiStripper();
    // No trailing escape at all → no tail buffered.
    expect(strip('plain text')).toBe('plain text');
    expect(strip('more')).toBe('more');
  });
});
