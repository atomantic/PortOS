import { act, renderHook } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import socket from '../../../services/socket';
import useMusicVideoRun from './useMusicVideoRun.js';

vi.mock('../../../services/socket', () => ({
  default: { on: vi.fn(), off: vi.fn() },
}));

const event = 'music-video:production';

function setup() {
  const replaceProject = vi.fn();
  const toasts = { running: vi.fn(), 'needs-human': vi.fn() };
  const hook = renderHook(({ projectId }) => useMusicVideoRun({
    projectId, event, toasts, errorLabel: 'Run request failed', replaceProject,
  }), { initialProps: { projectId: 'first' } });
  return { ...hook, replaceProject, toasts };
}

const receiver = () => vi.mocked(socket.on).mock.lastCall[1];
const runEvent = (projectId, status) => ({
  projectId,
  project: { id: projectId },
  run: { id: 'run', status },
});

it('skips initial running and toasts once for each subsequent status transition', () => {
  const { toasts } = setup();
  const receive = receiver();
  act(() => receive(runEvent('first', 'running')));
  expect(toasts.running).not.toHaveBeenCalled();

  act(() => {
    receive(runEvent('first', 'needs-human'));
    receive(runEvent('first', 'needs-human'));
  });
  expect(toasts['needs-human']).toHaveBeenCalledTimes(1);

  act(() => {
    receive(runEvent('first', 'running'));
    receive(runEvent('first', 'needs-human'));
  });
  expect(toasts.running).toHaveBeenCalledTimes(1);
  expect(toasts['needs-human']).toHaveBeenCalledTimes(2);
});

it('ignores events and pending replies for a superseded project', async () => {
  const { rerender, result, replaceProject, toasts } = setup();
  const oldReceiver = receiver();
  let finish;
  const request = new Promise((resolve) => { finish = resolve; });
  let pending;
  act(() => { pending = result.current.call(() => request); });
  expect(result.current.busy).toBe(true);

  rerender({ projectId: 'next' });
  const receive = receiver();
  await act(async () => {
    oldReceiver(runEvent('first', 'needs-human'));
    receive(runEvent('first', 'needs-human'));
    finish(runEvent('first', 'needs-human'));
    expect(await pending).toBeNull();
  });
  expect(toasts['needs-human']).not.toHaveBeenCalled();
  expect(replaceProject).not.toHaveBeenCalled();
  expect(result.current.busy).toBe(false);

  act(() => receive(runEvent('next', 'needs-human')));
  expect(replaceProject).toHaveBeenCalledWith({ id: 'next' });
  expect(toasts['needs-human']).toHaveBeenCalledTimes(1);
});
