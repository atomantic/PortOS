/**
 * Launch one PortOS-owned Blender Python driver (a film's or a model's) through
 * the operator-checked Blender tool and its supervised worker, and the Trusted
 * local gate both lanes apply first.
 *
 * Authored workspace code is the operator's own Python with host access, so
 * these lanes accept only Trusted local execution; a contained Blender is
 * refused (409), and nothing here changes that setting. The worker's own
 * workspace holds just the staged driver and job files; the driver writes its
 * outputs straight into the owner's workspace.
 */
import { join } from 'node:path';
import { PATHS } from '../../lib/paths.js';
import { codeAnimationWorkerFailure } from '../../lib/codeAnimationContainment.js';
import { blenderRefusal } from './containment.js';

// Shared with every other PortOS-owned Blender run; each run owns one UUID folder in it.
const WORKER_ROOT = 'code-animation-workspaces';

/** The checked Blender tool; 409 with `message` when it is not Trusted local, or the tool's own 409 when not ready. */
export async function requireTrustedLocalBlender(message) {
  const { getCodeAnimationExecution, resolveBlenderTool } = await import('../codeAnimation/execution.js');
  if ((await getCodeAnimationExecution()).executionMode !== 'trusted-local') {
    throw blenderRefusal(message, 'MUSIC_VIDEO_BLENDER_NEEDS_TRUSTED_LOCAL', 409);
  }
  return resolveBlenderTool();
}

/**
 * Run `entrypoint` (one of `files`, staged with `job.json` beside it) in
 * background Blender with factory settings and auto-run scripts off.
 * `parseLine(line)` turns a stdout line into a protocol event or null;
 * `onEvent(event)` receives each event and `onLog(line)` every other line (an
 * `error` event's traceback is the caller's to write out). Resolves
 * `{ ok, canceled, error, traceback }`; a failure is a value, not a throw.
 */
export async function runBlenderDriverScript({
  tool, entrypoint, files, limits, signal, parseLine, onEvent = () => {}, onLog = () => {}, onOutput,
}) {
  let failure = null;
  const run = await tool.worker({
    tool: {
      executable: tool.executable,
      argv: (entry, workspace) => ['--background', '--factory-startup', '--disable-autoexec', '--python-exit-code', '1',
        '--python', entry, '--', join(workspace, 'input', 'job.json')],
    },
    workspaceRoot: join(PATHS.data, WORKER_ROOT),
    entrypoint,
    files,
    limits,
    signal,
    onStdoutLine: (line) => {
      const event = parseLine(line);
      // The error event carries its traceback JSON-escaped on one line; the caller writes it out as text.
      if (event?.event !== 'error') onLog(line);
      if (!event) return;
      if (event.event === 'error') failure = event;
      onEvent(event);
    },
    onStderrLine: onLog,
    onOutput,
  });
  if (run.status === 'completed') return { ok: true, canceled: false, error: null, traceback: null };
  const canceled = run.status === 'terminated' && run.reason === 'canceled';
  return {
    ok: false, canceled,
    error: canceled ? 'Canceled' : failure?.message || codeAnimationWorkerFailure(run),
    traceback: failure?.traceback || null,
  };
}
