import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { expect, it, vi } from 'vitest';
import { openAvatarWorker } from './avatarWorker.js';

function workerFixture() {
  const child = new EventEmitter();
  for (const pipe of ['stdin', 'stdout', 'stderr']) child[pipe] = new PassThrough();
  child.kill = vi.fn(() => child.emit('close'));
  const messages = [];
  child.stdin.on('data', chunk => messages.push(JSON.parse(chunk.toString())));
  const send = event => child.stdout.write(JSON.stringify(event) + '\n');
  const close = vi.fn();
  const launch = vi.fn(() => child);
  const worker = openAvatarWorker('/fixture/python', close, launch);
  send({ type: 'ready' });
  return { child, messages, send, close, launch, worker };
}

it('delivers only the current render frames and sends cancel over private pipes', async () => {
  const { worker, messages, send, close, launch } = workerFixture();
  try {
    await worker.warmed;
    const signal = new AbortController();
    const onFrame = vi.fn();
    const render = worker.render(Buffer.from('wave'), { onFrame, signal: signal.signal });
    const [command] = messages;
    expect(launch.mock.calls[0][0]).toBe('/usr/bin/sandbox-exec');
    expect(launch.mock.calls[0][1][1]).toContain('(deny network*)');
    expect(launch.mock.calls[0][2].env).not.toHaveProperty('GH_TOKEN');
    expect(command.type).toBe('speak');
    await expect(worker.render(Buffer.from('other'), { onFrame, signal: signal.signal })).rejects.toThrow('already animating');
    const frame = { type: 'frame', id: command.id, index: 0, timeMs: 0, jpeg: 'fixture' };
    send({ ...frame, id: 'another-request' });
    send(frame);
    expect(onFrame).toHaveBeenCalledExactlyOnceWith({ index: 0, timeMs: 0, jpeg: 'fixture' });
    signal.abort();
    const onReplayFrame = vi.fn();
    const replay = worker.render(Buffer.from('second wave'), { onFrame: onReplayFrame, signal: new AbortController().signal });
    expect(messages[1]).toEqual({ type: 'cancel', id: command.id });
    send({ ...frame, index: 1, timeMs: 40 });
    send({ type: 'cancelled', id: command.id });
    await render;
    await vi.waitFor(() => expect(messages[2]?.type).toBe('speak'));
    send(frame); // An old frame can never enter the new render.
    const id = messages[2].id;
    send({ ...frame, id, jpeg: 'different' });
    send({ type: 'done', id });
    await replay;
    expect(onFrame).toHaveBeenCalledTimes(1);
    expect(onReplayFrame).toHaveBeenCalledExactlyOnceWith({ index: 0, timeMs: 0, jpeg: 'different' });
  } finally {
    worker.stop();
  }
  expect(close).toHaveBeenCalledWith(true);
});

it('fails incomplete playback if the worker exits instead of holding a render open', async () => {
  const { worker, child, close } = workerFixture();
  await worker.warmed;
  const render = worker.render(Buffer.from('wave'), { onFrame: vi.fn(), signal: new AbortController().signal });
  child.emit('close');
  await expect(render).rejects.toThrow('stopped before it finished');
  expect(close).toHaveBeenCalledWith(false);
});

it('streams continuous idle frames and preempts idle immediately when speech arrives', async () => {
  const { worker, messages, send } = workerFixture();
  try {
    await worker.warmed;
    const onIdleFrame = vi.fn();
    const idle = worker.renderIdle({ stage: 'listening', onFrame: onIdleFrame, signal: new AbortController().signal });
    expect(messages[0]).toMatchObject({ type: 'idle', stage: 'listening' });
    const idleId = messages[0].id;
    send({ type: 'frame', id: idleId, index: 0, timeMs: 0, jpeg: 'idle0' });
    expect(onIdleFrame).toHaveBeenCalledExactlyOnceWith({ index: 0, timeMs: 0, jpeg: 'idle0' });

    // Speech immediately cancels idle, waits for its cancelled ack, and starts speak.
    const onSpeakFrame = vi.fn();
    const speak = worker.render(Buffer.from('speech'), { onFrame: onSpeakFrame, signal: new AbortController().signal });
    expect(messages[1]).toEqual({ type: 'cancel', id: idleId });
    send({ type: 'frame', id: idleId, index: 1, timeMs: 40, jpeg: 'late-idle' });
    send({ type: 'cancelled', id: idleId });
    await idle;
    await vi.waitFor(() => expect(messages[2]?.type).toBe('speak'));
    const speakId = messages[2].id;

    // An idle request arriving while speech is active backs off without disturbing speech.
    const onIgnoredIdle = vi.fn();
    await worker.renderIdle({ stage: 'idle', onFrame: onIgnoredIdle, signal: new AbortController().signal });
    expect(onIgnoredIdle).not.toHaveBeenCalled();

    send({ type: 'frame', id: speakId, index: 0, timeMs: 0, jpeg: 'speech0' });
    send({ type: 'done', id: speakId });
    await speak;
    expect(onIdleFrame).toHaveBeenCalledTimes(1);
    expect(onSpeakFrame).toHaveBeenCalledExactlyOnceWith({ index: 0, timeMs: 0, jpeg: 'speech0' });
  } finally {
    worker.stop();
  }
});
