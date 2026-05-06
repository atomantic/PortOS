import { describe, expect, it } from 'vitest';
import { createCodexStderrFormatter } from './codexCliOutput.js';

describe('createCodexStderrFormatter', () => {
  it('drops Codex startup prompt echo and keeps the real runtime error', () => {
    const formatter = createCodexStderrFormatter();

    const lines = formatter.processChunk(`Reading prompt from stdin...
OpenAI Codex v0.125.0 (research preview)
--------
workdir: /repo
model: gpt-5
provider: openai
approval: never
sandbox: workspace-write
reasoning effort: high
session id: abc
--------
user
PortOS intentionally omits authentication in this deployment.
Begin working now.
ERROR: {"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The 'gpt-5' model is not supported when using Codex with a ChatGPT account."}}
`);

    expect(lines).toEqual([
      'ERROR: {"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The \'gpt-5\' model is not supported when using Codex with a ChatGPT account."}}'
    ]);
  });

  it('summarizes Codex exec lines without retaining command output', () => {
    const formatter = createCodexStderrFormatter();

    const lines = formatter.processChunk("exec bash -lc 'npm test' in /repo succeeded in 2s:\nlong command output\n");

    expect(lines).toEqual(['🔧 npm test']);
  });

  it('does not leak prompt lines containing error keywords before the separator', () => {
    const userPrompt = 'Debug why the api key is not working and why the model is not supported.';
    const formatter = createCodexStderrFormatter(userPrompt);

    const lines = formatter.processChunk(`Reading prompt from stdin...
OpenAI Codex v0.125.0 (research preview)
--------
workdir: /repo
model: gpt-4o
provider: openai
approval: never
sandbox: workspace-write
session id: abc
--------
user
Debug why the api key is not working and why the model is not supported.
`);

    expect(lines).toEqual([]);
  });

  it('emits a real ERROR: line that arrives after the separator', () => {
    const formatter = createCodexStderrFormatter();

    const lines = formatter.processChunk(`Reading prompt from stdin...
OpenAI Codex v0.125.0 (research preview)
--------
workdir: /repo
model: gpt-4o
provider: openai
approval: never
sandbox: workspace-write
session id: abc
--------
user
Some normal prompt text.
ERROR: {"type":"error","status":401,"error":{"type":"invalid_request_error","message":"api key not valid"}}
`);

    expect(lines).toEqual([
      'ERROR: {"type":"error","status":401,"error":{"type":"invalid_request_error","message":"api key not valid"}}'
    ]);
  });

  it('formats exec lines after the separator as tool emoji', () => {
    const formatter = createCodexStderrFormatter();

    const lines = formatter.processChunk(`Reading prompt from stdin...
OpenAI Codex v0.125.0 (research preview)
--------
workdir: /repo
model: gpt-4o
provider: openai
approval: never
sandbox: workspace-write
session id: abc
--------
user
Some prompt.
exec /bin/bash -lc 'ls -la' in /repo succeeded in 0.5s:
file output
`);

    expect(lines).toEqual(['🔧 ls -la']);
  });

  it('emits plain-text "not logged in" as the first post-boundary runtime line', () => {
    const formatter = createCodexStderrFormatter();

    const lines = formatter.processChunk(`Reading prompt from stdin...
OpenAI Codex v0.125.0 (research preview)
--------
workdir: /repo
model: gpt-4o
provider: openai
approval: never
sandbox: workspace-write
session id: abc
--------
user
Some normal prompt text.
not logged in
`);

    expect(lines).toEqual(['not logged in']);
  });

  it('emits plain-text "quota exceeded" as the first post-boundary runtime line', () => {
    const formatter = createCodexStderrFormatter();

    const lines = formatter.processChunk(`Reading prompt from stdin...
OpenAI Codex v0.125.0 (research preview)
--------
workdir: /repo
model: gpt-4o
provider: openai
approval: never
sandbox: workspace-write
session id: abc
--------
user
Some normal prompt text.
quota exceeded
`);

    expect(lines).toEqual(['quota exceeded']);
  });

  it('drops echoed prompt lines matching userPrompt but still emits first plain runtime error', () => {
    const userPrompt = 'Debug why the api key is not working and why the model is not supported.';
    const formatter = createCodexStderrFormatter(userPrompt);

    const lines = formatter.processChunk(`Reading prompt from stdin...
OpenAI Codex v0.125.0 (research preview)
--------
workdir: /repo
model: gpt-4o
provider: openai
approval: never
sandbox: workspace-write
session id: abc
--------
user
Debug why the api key is not working and why the model is not supported.
not logged in
`);

    expect(lines).toEqual(['not logged in']);
  });

  it('emits ECONNREFUSED errors — matches both RUNTIME_SIGNAL_RE (Error:) and NETWORK_SIGNAL_RE', () => {
    const formatter = createCodexStderrFormatter();

    const lines = formatter.processChunk(`Reading prompt from stdin...
OpenAI Codex v0.125.0 (research preview)
--------
workdir: /repo
model: gpt-4o
provider: openai
approval: never
sandbox: workspace-write
session id: abc
--------
user
Some normal prompt.
Error: ECONNREFUSED 127.0.0.1:11434
`);

    expect(lines).toEqual(['Error: ECONNREFUSED 127.0.0.1:11434']);
  });

  it('emits plain "socket hang up" via NETWORK_SIGNAL_RE after prompt boundary', () => {
    const formatter = createCodexStderrFormatter();

    const lines = formatter.processChunk(`Reading prompt from stdin...
OpenAI Codex v0.125.0 (research preview)
--------
workdir: /repo
model: gpt-4o
provider: openai
approval: never
sandbox: workspace-write
session id: abc
--------
user
Some normal prompt.
socket hang up
`);

    expect(lines).toEqual(['socket hang up']);
  });

  it('emits plain "connect timeout" via NETWORK_SIGNAL_RE after prompt boundary', () => {
    const formatter = createCodexStderrFormatter();

    const lines = formatter.processChunk(`Reading prompt from stdin...
OpenAI Codex v0.125.0 (research preview)
--------
workdir: /repo
model: gpt-4o
provider: openai
approval: never
sandbox: workspace-write
session id: abc
--------
user
Some normal prompt.
connect timeout after 30s
`);

    expect(lines).toEqual(['connect timeout after 30s']);
  });

  it('still drops "connection refused" that appears in user-prompt zone (promptLineSet filter)', () => {
    // A prompt containing "connection refused" must NOT leak — the promptLineSet.has check
    // fires before ERROR_SIGNAL_RE / NETWORK_SIGNAL_RE, so exact-match prompt lines are
    // dropped regardless of network keyword content.
    const userPrompt = 'Why does the server say connection refused on port 8080?';
    const formatter = createCodexStderrFormatter(userPrompt);

    const lines = formatter.processChunk(`Reading prompt from stdin...
OpenAI Codex v0.125.0 (research preview)
--------
workdir: /repo
model: gpt-4o
provider: openai
approval: never
sandbox: workspace-write
session id: abc
--------
user
Why does the server say connection refused on port 8080?
`);

    expect(lines).toEqual([]);
  });
});
