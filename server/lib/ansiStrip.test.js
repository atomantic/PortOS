import { describe, it, expect } from 'vitest';
import { stripAnsi, createStreamingAnsiStripper, ANSI_PATTERN } from './ansiStrip.js';

// These tests pin the behavior of the streaming stripper, including OSC
// handling: terminator-bearing sequences are fully consumed, and a bare
// `\x1B]` with no terminator falls through to the single-byte branch.

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

  it('strips a complete BEL-terminated OSC sequence (opener + body + BEL)', () => {
    expect(stripAnsi('\x1B]0;title\x07after')).toBe('after');
  });

  it('strips a complete ST-terminated OSC sequence (opener + body + ESC \\\\)', () => {
    expect(stripAnsi('\x1B]0;title\x1B\\after')).toBe('after');
  });

  it('strips an OSC hyperlink (ESC ] 8 ; ; URL BEL TEXT ESC ] 8 ; ; BEL)', () => {
    // Real-world example: terminal hyperlinks. Both OSC chunks must be
    // consumed whole, leaving just the visible link text.
    expect(stripAnsi('\x1B]8;;https://example.com\x07link\x1B]8;;\x07')).toBe('link');
  });

  it('does not swallow visible text between two adjacent ST-terminated OSC sequences', () => {
    // Body alternation must stop at the FIRST `\x1B\\`. Without the
    // `\x1B(?!\\)` guard, greedy `[^\x07]*` would match past the inner ST
    // and consume `VISIBLE`.
    expect(stripAnsi('\x1B]0;one\x1B\\VISIBLE\x1B]0;two\x1B\\after')).toBe('VISIBLEafter');
  });

  it('does not swallow visible text when an ST-OSC is followed by a BEL-OSC', () => {
    expect(stripAnsi('\x1B]0;one\x1B\\VISIBLE\x1B]0;two\x07after')).toBe('VISIBLEafter');
  });

  it('treats a bare ESC inside an OSC body (not followed by `\\\\`) as part of the body', () => {
    // `\x1B(?!\\)` lets a stray non-ST ESC stay in the body; the whole
    // sequence still strips when a real terminator arrives.
    expect(stripAnsi('\x1B]0;foo\x1Bbar\x07after')).toBe('after');
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

  it('buffers an OSC opener split across chunks and fully strips the sequence on flush (BEL)', () => {
    // Streaming defers the chunk boundary inside an OSC opener — the
    // trailing `\x1B]0;ti` is held until the next chunk arrives. When the
    // BEL terminator lands the full reassembled sequence strips cleanly.
    const strip = createStreamingAnsiStripper();
    expect(strip('pre\x1B]0;ti')).toBe('pre');
    expect(strip('tle\x07post')).toBe('post');
  });

  it('buffers an OSC opener split across three chunks then fully strips it', () => {
    const strip = createStreamingAnsiStripper();
    expect(strip('A\x1B]')).toBe('A');
    expect(strip('8;;https://example.com')).toBe('');
    expect(strip('\x07Z')).toBe('Z');
  });

  it('buffers an in-progress OSC whose body contains a bare ESC, split before the terminator', () => {
    // The OSC opener anchor must use `\x1B]` (not `\x1B`) so a body byte
    // doesn't masquerade as the start of the candidate fragment. Without
    // this, `\x1B]0;foo\x1Bbar` then `\x07after` would leak the OSC body to
    // the cleaned stream.
    const strip = createStreamingAnsiStripper();
    expect(strip('\x1B]0;foo\x1Bbar')).toBe('');
    expect(strip('\x07after')).toBe('after');
  });

  it('buffers an in-progress OSC whose body contains another `\\x1B]`, split before the terminator', () => {
    // The body grammar `\x1B(?!\\)` allows the body to contain `\x1B]`.
    // The streaming anchor must therefore find the LEFTMOST `\x1B]` whose
    // suffix is incomplete — anchoring on the rightmost would strip the
    // outer opener as a single-byte escape and leak the body prefix.
    const strip = createStreamingAnsiStripper();
    expect(strip('\x1B]0;foo\x1B]bar')).toBe('');
    expect(strip('\x07after')).toBe('after');
  });

  it('processes pathological input with many `\\x1B]` candidates in linear time', () => {
    // Regression for a ReDoS path discovered in review: an unanchored
    // `combined.match(/\x1B\]...$/)` ran the body match from each `\x1B]`
    // starting position and the `$` anchor forced O(n) work per attempt,
    // totalling O(n²). 15K reps + ST took ~2.3 s. The current scan is
    // strictly O(n) — this input should resolve in milliseconds.
    const strip = createStreamingAnsiStripper();
    const pathological = '\x1B]x'.repeat(15000) + '\x1B\\';
    const start = Date.now();
    const out = strip(pathological);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(250);
    // The whole reassembled string is one valid OSC (body permits the
    // inner `\x1B]` markers and ends at the ST), so nothing leaks.
    expect(out).toBe('');
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
