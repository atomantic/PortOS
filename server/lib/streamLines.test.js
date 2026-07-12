import { describe, it, expect } from 'vitest';
import { createLineReader } from './streamLines.js';

const collect = (opts) => {
  const lines = [];
  const reader = createLineReader((l) => lines.push(l), opts);
  return { lines, reader };
};

describe('createLineReader', () => {
  it('emits complete newline-terminated lines and holds the partial tail', () => {
    const { lines, reader } = collect();
    reader.push('alpha\nbeta\npar');
    expect(lines).toEqual(['alpha', 'beta']); // 'par' is still buffered
    reader.push('tial\n');
    expect(lines).toEqual(['alpha', 'beta', 'partial']);
  });

  it('joins a line split across two chunks', () => {
    const { lines, reader } = collect();
    reader.push('STAGE:down');
    reader.push('load:3/5\n');
    expect(lines).toEqual(['STAGE:download:3/5']);
  });

  it('handles \\r\\n (Windows) newlines with the default split', () => {
    const { lines, reader } = collect();
    reader.push('one\r\ntwo\r\n');
    expect(lines).toEqual(['one', 'two']);
  });

  it('flush() emits a final line written without a trailing newline', () => {
    const { lines, reader } = collect();
    reader.push('done-no-newline');
    expect(lines).toEqual([]); // nothing yet — no separator seen
    reader.flush();
    expect(lines).toEqual(['done-no-newline']);
  });

  it('flush() is a no-op when the buffer is empty or already drained', () => {
    const { lines, reader } = collect();
    reader.push('x\n');
    expect(lines).toEqual(['x']);
    reader.flush();
    reader.flush();
    expect(lines).toEqual(['x']); // no spurious empty-string line
  });

  it('does not emit an empty trailing line after a terminating newline until flushed', () => {
    const { lines, reader } = collect();
    reader.push('only\n');
    expect(lines).toEqual(['only']);
    reader.flush(); // carry is '' -> no-op
    expect(lines).toEqual(['only']);
  });

  it('supports splitRe: /[\\r\\n]+/ for bare-\\r progress redraws', () => {
    const { lines, reader } = collect({ splitRe: /[\r\n]+/ });
    reader.push('10%\r20%\r30%'); // no trailing separator — '30%' still redrawing
    expect(lines).toEqual(['10%', '20%']); // '30%' held until next \r or flush
    reader.flush();
    expect(lines).toEqual(['10%', '20%', '30%']);
  });

  it('collapses runs of separators with /[\\r\\n]+/ WITHIN a chunk (no empty lines between redraws)', () => {
    const { lines, reader } = collect({ splitRe: /[\r\n]+/ });
    reader.push('a\r\n\r\nb\n');
    expect(lines).toEqual(['a', 'b']);
  });

  it('a separator run split across a chunk boundary can yield one empty segment (callers filter empties)', () => {
    // Documents the collapsing-regex boundary behavior codex flagged: because
    // splitting is incremental, a `\r` in one chunk and `\n` in the next are
    // not collapsed into one separator, so an empty segment appears. Every
    // caller that passes /[\r\n]+/ discards empty lines, which is the contract.
    const { lines, reader } = collect({ splitRe: /[\r\n]+/ });
    reader.push('a\r');
    reader.push('\nb\n');
    expect(lines.filter((l) => l !== '')).toEqual(['a', 'b']);
  });

  it('stitches a multibyte UTF-8 codepoint split across chunk boundaries (Buffer input)', () => {
    const { lines, reader } = collect();
    // '🎬' (U+1F3AC) is 4 UTF-8 bytes at indices 6-9 of this string; cut at
    // byte 8 so the emoji is split across the two chunks.
    const full = Buffer.from('TITLE:🎬 clip\n', 'utf8');
    reader.push(full.subarray(0, 8)); // 'TITLE:' + first 2 emoji bytes
    reader.push(full.subarray(8));    // last 2 emoji bytes + ' clip\n'
    expect(lines).toEqual(['TITLE:🎬 clip']);
    expect(lines[0]).not.toContain('�'); // no replacement chars
  });

  it('flush() drains a trailing incomplete multibyte sequence without a newline', () => {
    const { lines, reader } = collect();
    const buf = Buffer.from('café', 'utf8'); // 'é' is 2 bytes
    reader.push(buf.subarray(0, buf.length - 1)); // drop the last byte of 'é'
    reader.push(buf.subarray(buf.length - 1)); // deliver it
    reader.flush();
    expect(lines).toEqual(['café']);
  });

  it('clamps the carry buffer when no separator arrives within maxCarry', () => {
    const { lines, reader } = collect({ maxCarry: 8 });
    reader.push('123456789'); // 9 chars, exceeds maxCarry of 8, no newline
    expect(lines).toEqual(['123456789']); // flushed as a safety-valve line
    reader.push('next\n');
    expect(lines).toEqual(['123456789', 'next']); // buffer reset cleanly
  });

  it('gives each stream reader an independent carry buffer', () => {
    const out = [];
    const stdout = createLineReader((l) => out.push(`o:${l}`));
    const stderr = createLineReader((l) => out.push(`e:${l}`));
    stdout.push('OUT-par');
    stderr.push('ERR-full\n');
    stdout.push('tial\n');
    expect(out).toEqual(['e:ERR-full', 'o:OUT-partial']);
  });
});
