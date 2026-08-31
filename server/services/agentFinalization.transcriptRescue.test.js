/**
 * Transcript rescue for a programmatic-I/O payload the model PRINTED into its
 * TUI instead of writing to `.agent-done` (#3640).
 *
 * Drives the real `dispatchTaskOutputHookOnce` against an on-disk agent dir
 * (raw.txt spool) and an on-disk workspace, so the "sentinel absent" branch and
 * the tail read are exercised end to end rather than stubbed.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { makePathsProxy } from '../lib/mockPathsDataRoot.js';

// Allocated inside `vi.hoisted` so the binding exists BEFORE the module graph is
// imported: agentFinalization pulls modules (cos.js → appActivity.js, taskLearning)
// that read `PATHS` at import time, which runs the mock factory below while a
// plain module-level `const` would still be in its temporal dead zone.
const { TEMP_ROOT } = await vi.hoisted(async () => {
  const { mkdtempSync } = await import('fs');
  const { tmpdir } = await import('os');
  const { join: joinPath } = await import('path');
  return { TEMP_ROOT: mkdtempSync(joinPath(tmpdir(), 'portos-transcript-rescue-')) };
});

vi.mock('../lib/fileUtils.js', async () => {
  const actual = await vi.importActual('../lib/fileUtils.js');
  return makePathsProxy(actual, { dataRoot: TEMP_ROOT });
});

vi.mock('./cosAgentLifecycle.js', () => ({
  getAgent: vi.fn(async () => ({ id: 'agent-example', status: 'running', metadata: {} })),
  getAgentRecord: vi.fn(async () => ({ id: 'agent-example', status: 'running', metadata: {} })),
  updateAgent: vi.fn(async () => ({})),
  completeAgent: vi.fn(async () => ({})),
}));

vi.mock('./taskTypeHooks.js', () => ({
  canRunTaskOutputHookWithoutPayload: vi.fn(() => false),
  declaresNoCommitCriterion: vi.fn(() => false),
  isProgrammaticIoTaskType: vi.fn(() => true),
  resolveTaskHookType: vi.fn(task => task?.metadata?.analysisType || null),
  getTaskOutputHook: vi.fn(),
  getTaskOutputPayloadPredicate: vi.fn(),
}));

import {
  getTaskOutputHook,
  getTaskOutputPayloadPredicate,
  isProgrammaticIoTaskType,
} from './taskTypeHooks.js';
import { dispatchTaskOutputHookOnce } from './agentFinalization.js';

// Mirrors layered-intelligence's exported `isTaskOutputPayload` predicate. Kept
// local rather than imported: that hook module pulls the whole apps/taskLearning
// chain, which reads PATHS at import time — before this file's temp root exists.
// `layeredIntelligenceHooks.test.js` asserts the real predicate matches this shape.
const isReasonerPayload = (p) => !!p && typeof p === 'object' && !Array.isArray(p)
  && ['analysis', 'proposal', 'pause'].some(k => Object.hasOwn(p, k));

const TASK = {
  id: 'sys-example',
  taskType: 'internal',
  metadata: { analysisType: 'layered-intelligence', app: 'app-example' },
};

// A repaint-heavy TUI transcript: ANSI colour/cursor sequences, a truncated
// redraw leaving a stray `{`, then whatever the model printed to the terminal
// instead of writing it to `.agent-done`. `echoSchema` prepends the prompt's own
// schema example — a well-formed envelope that appears BEFORE the real answer.
const REASONER_ANSWER = '{"analysis": "Nothing worth proposing this cycle.", "proposal": null, "pause": null}';
const printedTranscript = (answer = REASONER_ANSWER, { echoSchema = false } = {}) => [
  '\x1b[2J\x1b[H  layered-intelligence run starting\u2026\r\n',
  echoSchema
    ? '\x1b[1mRespond with\x1b[0m {"analysis": "<schema example>", "proposal": null, "pause": null}\r\n'
    : '',
  '\x1b[38;5;240m\u2502\x1b[0m thinking\u2026 { truncated repaint\r\n',
  `\x1b[32m\u25cf\x1b[0m ${answer}\r\n`,
  '\x1b[2mrun complete\x1b[0m\r\n',
].join('');

let agentId = 0;
const setupRun = ({ transcript, sentinel = null }) => {
  agentId += 1;
  const id = `agent-${agentId}`;
  const agentDir = join(TEMP_ROOT, 'cos/agents', id);
  const workspace = join(TEMP_ROOT, 'workspaces', id);
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(workspace, { recursive: true });
  if (transcript !== null) writeFileSync(join(agentDir, 'raw.txt'), transcript);
  // The sentinel filename is scoped to the agent instance (doneSentinelName).
  if (sentinel !== null) writeFileSync(join(workspace, `.agent-done-${id}`), sentinel);
  return { agentId: id, workspacePath: workspace };
};

const runDispatch = async (setup) => {
  const hook = vi.fn().mockResolvedValue({ action: 'no-op' });
  getTaskOutputHook.mockResolvedValue(hook);
  const { agentId: id, workspacePath } = setupRun(setup);
  await dispatchTaskOutputHookOnce({ agentId: id, task: TASK, success: true, workspacePath });
  return hook;
};

describe('printed-payload transcript rescue (#3640)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isProgrammaticIoTaskType.mockReturnValue(true);
    getTaskOutputPayloadPredicate.mockResolvedValue(isReasonerPayload);
  });

  afterAll(() => rmSync(TEMP_ROOT, { recursive: true, force: true }));

  it('hands the hook the payload the agent printed when no sentinel was written', async () => {
    const hook = await runDispatch({ transcript: printedTranscript() });

    expect(hook).toHaveBeenCalledWith(expect.objectContaining({
      success: true,
      payload: { analysis: 'Nothing worth proposing this cycle.', proposal: null, pause: null },
    }));
  });

  it('prefers the model final answer over an earlier prompt echo of the schema', async () => {
    const answer = '{"analysis": "Real answer", "proposal": {"scope": "self-improve", "title": "Do the thing"}}';
    const hook = await runDispatch({ transcript: printedTranscript(answer, { echoSchema: true }) });

    const { payload } = hook.mock.calls[0][0];
    expect(payload.analysis).toBe('Real answer');
    expect(payload.proposal.title).toBe('Do the thing');
  });

  it('does not rescue for a non-programmatic-I/O task with the same transcript', async () => {
    isProgrammaticIoTaskType.mockReturnValue(false);

    const hook = await runDispatch({ transcript: printedTranscript() });

    expect(hook).toHaveBeenCalledWith(expect.objectContaining({ payload: null }));
  });

  it('yields no payload for malformed or truncated JSON in the transcript', async () => {
    const hook = await runDispatch({
      transcript: printedTranscript('{"analysis": "cut off mid-thoug'),
    });

    expect(hook).toHaveBeenCalledWith(expect.objectContaining({ payload: null }));
  });

  it('yields no payload for transcript JSON that is not the hook deliverable', async () => {
    const hook = await runDispatch({ transcript: printedTranscript('{"tokens": 1200, "cost": 0.03}') });

    expect(hook).toHaveBeenCalledWith(expect.objectContaining({ payload: null }));
  });

  it('leaves a written sentinel authoritative instead of scraping an older transcript', async () => {
    const hook = await runDispatch({
      transcript: printedTranscript(),
      sentinel: 'plain markdown summary, no structured payload',
    });

    expect(hook).toHaveBeenCalledWith(expect.objectContaining({ payload: null }));
  });

  it('accepts a legacy bare payload written to the sentinel when the hook predicate matches', async () => {
    const bare = JSON.stringify({ analysis: 'quiet sentinel', proposal: null, pause: null });
    const hook = await runDispatch({ transcript: printedTranscript(), sentinel: bare });

    expect(hook).toHaveBeenCalledWith(expect.objectContaining({
      payload: { analysis: 'quiet sentinel', proposal: null, pause: null },
    }));
  });

  it('accepts the documented envelope form when that is what was printed', async () => {
    const envelope = '{"summary": "no proposal", "payload": {"analysis": "quiet", "proposal": null}}';
    const hook = await runDispatch({ transcript: printedTranscript(envelope) });

    expect(hook).toHaveBeenCalledWith(expect.objectContaining({
      payload: { analysis: 'quiet', proposal: null },
    }));
  });

  it('skips the rescue when the task type declares no payload predicate', async () => {
    getTaskOutputPayloadPredicate.mockResolvedValue(null);

    const hook = await runDispatch({ transcript: printedTranscript() });

    expect(hook).toHaveBeenCalledWith(expect.objectContaining({ payload: null }));
  });

  it('tolerates a missing raw.txt spool', async () => {
    const hook = await runDispatch({ transcript: null });

    expect(hook).toHaveBeenCalledWith(expect.objectContaining({ payload: null }));
  });
});
