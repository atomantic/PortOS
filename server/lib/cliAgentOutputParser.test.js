import { describe, it, expect } from 'vitest';
import { createCliAgentOutputParser, RAW_STREAM_BUFFER_CAP } from './cliAgentOutputParser.js';

const delta = (text) => `${JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } })}\n`;
const result = (text) => `${JSON.stringify({ type: 'result', result: text })}\n`;

/** Feed `payload` in `size`-char chunks and collect what the parser emitted per stream. */
function feed(parser, stream, payload, size) {
  const out = { lines: [], text: '', fallbackSignals: [] };
  for (let i = 0; i < payload.length; i += size) {
    const r = parser[stream](Buffer.from(payload.slice(i, i + size)));
    out.lines.push(...r.lines);
    out.text += r.text;
    if (r.fallbackSignal) out.fallbackSignals.push(r.fallbackSignal);
  }
  return out;
}

describe('createCliAgentOutputParser stream-json', () => {
  const payload = delta('first line\n') + delta('second line\n') + result('Final answer.');

  it.each([1, 7, 64, 100000])('yields the same lines however stdout is chunked (size %i)', (size) => {
    const parser = createCliAgentOutputParser({ command: 'claude', args: ['--output-format', 'stream-json'] });
    const out = feed(parser, 'stdout', payload, size);
    const flushed = parser.flush();
    expect([...out.lines, ...flushed.lines].join('\n')).toContain('first line');
    expect([...out.lines, ...flushed.lines].join('\n')).toContain('second line');
    expect(flushed.finalResult).toBe('Final answer.');
    expect(flushed.completionResult).toBe('Final answer.');
    expect(parser.rawStream()).toBe(payload);
  });

  it('holds a JSON event split across chunks until the line completes', () => {
    const parser = createCliAgentOutputParser({ args: ['stream-json'] });
    const line = delta('whole\n');
    const split = Math.floor(line.length / 2);
    expect(parser.stdout(line.slice(0, split)).lines).toEqual([]);
    expect(parser.stdout(line.slice(split)).lines.join('')).toContain('whole');
  });

  it('prefers a declared streamFormat over the argv, and falls back to argv only when none is declared', () => {
    const asArgs = createCliAgentOutputParser({ args: ['stream-json'] });
    expect(asArgs.stdout(delta('x\n')).text).toBe('');
    const declaredText = createCliAgentOutputParser({ args: ['stream-json'], streamFormat: 'text' });
    expect(declaredText.stdout('plain\n').text).toBe('plain\n');
    const declaredStream = createCliAgentOutputParser({ args: [], streamFormat: 'stream-json' });
    expect(declaredStream.stdout(delta('y\n')).lines.join('')).toContain('y');
  });

  it('keeps only the last 512 KiB of the raw stream', () => {
    const parser = createCliAgentOutputParser({ args: ['stream-json'] });
    parser.stdout('x'.repeat(RAW_STREAM_BUFFER_CAP + 1000));
    parser.stdout('END');
    expect(parser.rawStream().length).toBe(RAW_STREAM_BUFFER_CAP);
    expect(parser.rawStream().endsWith('END')).toBe(true);
  });

  it('does not run the ANSI scan over stream-json stdout', () => {
    const parser = createCliAgentOutputParser({ args: ['stream-json'] });
    parser.stdout('\x1b[3');
    expect(parser.rawStream()).toBe('\x1b[3');
  });
});

describe('createCliAgentOutputParser plain output', () => {
  it('strips an ANSI escape split across stdout chunks and keeps blank lines', () => {
    const parser = createCliAgentOutputParser({ command: 'opencode', args: ['run'] });
    const out = feed(parser, 'stdout', 'hello \x1b[31mworld\x1b[0m\n\n', 3);
    expect(out.text).toBe('hello world\n\n');
    expect(parser.rawStream()).toBe('');
  });

  it('tags real stderr, and drops pure-control, whitespace and known-noise chunks', () => {
    const parser = createCliAgentOutputParser({ command: 'opencode', args: ['run'] });
    expect(parser.stderr('\x1b[0m   \n').text).toBe('');
    expect(parser.stderr('[claude-code:unrecognized_model] unrecognized model x\n').text).toBe('');
    expect(parser.stderr('\x1b[31mreal warning\x1b[0m\n').text).toBe('[stderr] real warning\n');
  });

  it('keeps stdout and stderr escape state independent', () => {
    const parser = createCliAgentOutputParser({ command: 'opencode', args: [] });
    parser.stdout('a\x1b[3');
    expect(parser.stderr('\x1b[0mwarn\n').text).toBe('[stderr] warn\n');
    expect(parser.stdout('1mb\n').text).toBe('b\n');
  });
});

describe('createCliAgentOutputParser codex stderr', () => {
  const stderrFeed = `Reading prompt from stdin...
OpenAI Codex v0.125.0 (research preview)
--------
workdir: /repo
model: gpt-5
--------
user
Debug why the api key is wrong
ERROR: boom
`;

  it.each([['codex'], ['/usr/local/bin/codex'], ['codex.exe']])('formats stderr for the %s binary, hiding config and echoed prompt', (command) => {
    const parser = createCliAgentOutputParser({ command, args: ['exec'], prompt: 'Debug why the api key is wrong' });
    const out = feed(parser, 'stderr', stderrFeed, 11);
    expect([...out.lines, ...parser.flush().lines]).toEqual(['ERROR: boom']);
    expect(out.text).toBe('');
  });

  it('keys on the binary, not the provider id, so codex-ollama style providers get the formatter', () => {
    const parser = createCliAgentOutputParser({ command: 'codex', args: ['--oss'], prompt: '' });
    expect(parser.stderr('workdir: /repo\n').text).toBe('');
    const plain = createCliAgentOutputParser({ command: 'agy', args: [] });
    expect(plain.stderr('workdir: /repo\n').text).toBe('[stderr] workdir: /repo\n');
  });

  it('flushes an unterminated final codex line', () => {
    const parser = createCliAgentOutputParser({ command: 'codex', args: [] });
    parser.stderr('--------\nERROR: tail without newline');
    expect(parser.flush().lines).toEqual(['ERROR: tail without newline']);
  });
});

describe('createCliAgentOutputParser fallback signal', () => {
  it('reports a usage-limit banner once, even when it is split across chunks', () => {
    const parser = createCliAgentOutputParser({ command: 'opencode', args: [] });
    const out = feed(parser, 'stdout', 'working...\nNow using extra usage\nmore text\nNow using extra usage\n', 5);
    expect(out.fallbackSignals).toHaveLength(1);
    expect(out.fallbackSignals[0]).toMatchObject({ requiresFallback: true, category: expect.any(String) });
  });

  it('detects on stderr text and on stream-json stdout', () => {
    const onStderr = createCliAgentOutputParser({ command: 'opencode', args: [] });
    expect(onStderr.stderr('Now using extra usage\n').fallbackSignal).toBeTruthy();
    const onStream = createCliAgentOutputParser({ args: ['stream-json'] });
    expect(onStream.stdout(delta('Now using extra usage\n')).fallbackSignal).toBeNull();
    expect(onStream.stdout('Now using extra usage\n').fallbackSignal).toBeTruthy();
  });

  it('stays quiet for ordinary output', () => {
    const parser = createCliAgentOutputParser({ command: 'opencode', args: [] });
    expect(feed(parser, 'stdout', 'all good\n', 4).fallbackSignals).toEqual([]);
  });
});
