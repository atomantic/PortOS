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

  it('collapses runs of separators with /[\\r\\n]+/ (no empty lines between redraws)', () => {
    const { lines, reader } = collect({ splitRe: /[\r\n]+/ });
    reader.push('a\r\n\r\nb\n');
    expect(lines).toEqual(['a', 'b']);
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
