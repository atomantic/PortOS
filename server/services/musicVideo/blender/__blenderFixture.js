/**
 * Test double for the Blender tool a film job runs through: an execution
 * report, a `resolveBlenderTool` and a worker that plays the driver's part
 * (reads the staged job.json, writes frames where the real driver would, and
 * prints the same protocol lines) without starting Blender. Shared by the
 * Blender film route, render-dispatch and host-control suites.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { ServerError } from '../../../lib/errorHandler.js';

const line = (event) => `PORTOS_BLENDER ${JSON.stringify(event)}`;

export const createFakeBlender = () => {
  const control = {
    // What describe() returns; `describeError` makes it raise instead, and
    // `describeHold` is a promise it waits on first (a describe that hangs).
    manifest: null,
    describeError: null,
    describeHold: null,
    executionMode: 'trusted-local',
    ready: true,
    // Every job.json the worker was handed, in order.
    jobs: [],
    // A promise the first frame of each render waits on (to cancel or inspect mid-render).
    hold: null,
    running: 0,
    peak: 0,
  };

  const frameFile = (job, shot, frame) => {
    if (job.quality === 'still') return join(job.out, shot.id, 'stills', `t${String(Math.round((frame / job.fps) * 1000)).padStart(9, '0')}.png`);
    return join(job.out, shot.id, job.quality, 'frames', `frame_${String(frame).padStart(6, '0')}.${job.quality === 'preview' ? 'jpg' : 'png'}`);
  };

  const render = async (job, { onStdoutLine, signal }) => {
    for (const shot of job.shots) {
      const first = Math.round(shot.start * job.fps);
      const frames = job.quality === 'still' ? job.frames : Array.from({ length: Math.round(shot.end * job.fps) - first }, (_, index) => first + index);
      onStdoutLine(line({ event: 'start', shot: shot.id, frames: frames.length, blender: '5.2.3', engine: 'BLENDER_EEVEE', device: 'GPU' }));
      onStdoutLine('00:01.000  render           | free-form Blender output');
      for (const [index, frame] of frames.entries()) {
        if (index === 1 && control.hold) {
          await Promise.race([control.hold, new Promise((resolve) => signal?.addEventListener('abort', resolve, { once: true }))]);
        }
        if (signal?.aborted) return { status: 'terminated', reason: 'canceled' };
        const path = frameFile(job, shot, frame);
        const skipped = Boolean(job.resume) && existsSync(path) && statSync(path).size > 0;
        if (!skipped) {
          mkdirSync(dirname(path), { recursive: true });
          writeFileSync(path, `frame ${frame}`);
        }
        onStdoutLine(line({ event: 'frame', shot: shot.id, frame, index: index + 1, total: frames.length, sec: skipped ? 0 : 0.25, skipped }));
      }
      if (job.saveBlend) {
        writeFileSync(join(job.out, shot.id, 'shot.blend'), 'blend');
        onStdoutLine(line({ event: 'blend', shot: shot.id, path: join(job.out, shot.id, 'shot.blend') }));
      }
      onStdoutLine(line({ event: 'done', shot: shot.id, sec: 1 }));
    }
    return { status: 'completed', reason: null };
  };

  const worker = async ({ files, onStdoutLine = () => {}, onOutput, signal }) => {
    const job = JSON.parse(String(files.find((file) => file.path === 'job.json').content));
    control.jobs.push({ ...job, staged: files.map((file) => file.path).sort() });
    control.running += 1;
    control.peak = Math.max(control.peak, control.running);
    const finish = (result) => { control.running -= 1; return { exitCode: result.status === 'completed' ? 0 : 1, signal: null, ...result }; };
    if (job.mode !== 'describe') return finish(await render(job, { onStdoutLine, signal }));
    // A cancel can land before the worker starts: an aborted signal never fires its listener again.
    if (control.describeHold && !signal?.aborted) {
      await Promise.race([control.describeHold, new Promise((resolve) => signal?.addEventListener('abort', resolve, { once: true }))]);
    }
    if (signal?.aborted) return finish({ status: 'terminated', reason: 'canceled' });
    if (control.describeError) {
      onStdoutLine(line({ event: 'error', message: control.describeError, traceback: 'Traceback (most recent call last):\n  example' }));
      return finish({ status: 'failed', reason: 'exit' });
    }
    const directory = mkdtempSync(join(tmpdir(), 'portos-fake-blender-'));
    const body = JSON.stringify(control.manifest);
    writeFileSync(join(directory, 'manifest.json'), body);
    onStdoutLine(line({ event: 'manifest', path: join(directory, 'manifest.json') }));
    await onOutput(directory, [{ path: 'manifest.json', bytes: Buffer.byteLength(body) }]);
    rmSync(directory, { recursive: true, force: true });
    return finish({ status: 'completed', reason: null });
  };

  const getCodeAnimationExecution = async () => ({
    executionMode: control.executionMode,
    lanes: { blender: { ready: control.ready, reason: control.ready ? null : 'Run the execution check; execution stays refused until it passes on this server process.' } },
    tools: { blender: { engine: 'BLENDER_EEVEE_NEXT', executable: '/opt/example/Blender' } },
    probe: control.ready ? { tools: { blender: { version: '5.2.3' } } } : null,
  });

  const resolveBlenderTool = async () => {
    if (!control.ready) throw new ServerError('Run the execution check first', { status: 409, code: 'CODE_ANIMATION_BLENDER_NOT_READY' });
    return { executable: '/opt/example/Blender', executionMode: control.executionMode, version: '5.2.3', worker };
  };

  return { control, worker, getCodeAnimationExecution, resolveBlenderTool };
};

/** A three-shot film over a six-second song at 24 fps. */
export const exampleManifest = () => ({
  title: 'Example Film',
  shots: [
    { id: 's010', label: 'Cold open', start: 0, end: 2, set: 'stage', summary: 'An empty stage.', action: 'The lights come up.', staging: 'Wide and symmetrical.', camera: 'Slow push in.', transition: 'Cut', deps: ['film.py', 'shots/s010.py'] },
    { id: 's020', label: 'Verse', start: 2, end: 4, summary: 'The band plays.', action: 'Three figures bounce.', staging: 'Chest height.', deps: ['film.py', 'shots/s020.py'] },
    { id: 's030', label: 'Chorus', start: 4, end: 6, summary: 'The sun swells.', action: 'A pull back.', staging: 'Low angle.', deps: ['film.py', 'shots/s030.py'] },
  ],
});
