import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';

const socketHandlers = new Map();
const emitted = [];
const cancellationRequests = [];
const socketState = { connected: true };
vi.mock('../../services/socket', () => ({
  default: {
    on: (event, fn) => { socketHandlers.set(event, fn); },
    off: (event, fn) => { if (socketHandlers.get(event) === fn) socketHandlers.delete(event); },
    emit: (event, payload) => { emitted.push({ event, payload }); },
    get connected() { return socketState.connected; },
    volatile: {
      timeout: () => ({
        emit: (event, payload, callback) => { cancellationRequests.push({ event, payload, callback }); },
      }),
    },
  },
}));

import { useAppDeploy } from './useAppDeploy';

const LOST = "Lost connection while this deploy ran; it has finished on the server. Check the app's logs or run Deploy again to confirm.";
const NOT_CONFIRMED = 'Lost connection before the server confirmed this deploy started. Run Deploy again.';
const fire = (event, payload) => act(() => { socketHandlers.get(event)(payload); });
const listRequests = () => emitted.filter(e => e.event === 'app:operations:list').length;
const active = (...operations) => fire('app:operations:active', { operations });
const liveDeploy = (appId = 'app-a', startedAt = 1000, steps = []) => ({ appId, appName: 'Example App', type: 'deploy', startedAt, steps });
const step = (message) => ({ step: message, status: 'running', message });

describe('useAppDeploy', () => {
  beforeEach(() => {
    socketHandlers.clear();
    emitted.length = 0;
    cancellationRequests.length = 0;
    socketState.connected = true;
  });

  it('reattaches on mount when the registry lists a live deploy for the app', () => {
    const { result } = renderHook(() => useAppDeploy('app-a'));
    expect(listRequests()).toBe(1);
    expect(result.current.isDeploying).toBe(false);

    active(
      { ...liveDeploy('app-a'), steps: [{ step: 'start', status: 'running', message: 'Starting deploy...' }] },
      liveDeploy('app-b'),
    );

    expect(result.current.isDeploying).toBe(true);
    expect(result.current.output.map(o => o.text)).toEqual(['--- Starting deploy... ---\n']);
  });

  it('ignores a live deploy of another app and an update of this one', () => {
    const { result } = renderHook(() => useAppDeploy('app-a'));
    active(liveDeploy('app-b'), { ...liveDeploy('app-a'), type: 'update' });
    expect(result.current.isDeploying).toBe(false);
  });

  it('settles with a visible message when a reconnect finds no deploy the hook was following', () => {
    const { result } = renderHook(() => useAppDeploy('app-a'));
    act(() => result.current.startDeploy(['--ios']));
    expect(emitted.at(-1)).toEqual({ event: 'app:deploy', payload: { appId: 'app-a', flags: ['--ios'] } });
    fire('app:deploy:output', { appId: 'app-a', text: 'building\n', stream: 'stdout', timestamp: 1 });
    expect(result.current.isDeploying).toBe(true);

    // Socket drops and reconnects; the terminal frame was lost with the old socket.
    fire('disconnect');
    const before = listRequests();
    fire('connect');
    expect(listRequests()).toBe(before + 1);
    active();

    expect(result.current.isDeploying).toBe(false);
    expect(result.current.error).toBe(LOST);
    expect(result.current.output).toHaveLength(1);
  });

  it('keeps following a deploy the registry still lists after a reconnect', () => {
    const { result } = renderHook(() => useAppDeploy('app-a'));
    active(liveDeploy());
    fire('connect');
    active(liveDeploy());
    expect(result.current.isDeploying).toBe(true);
    expect(result.current.error).toBeNull();
  });

  it('ignores frames and terminal frames for a different app', () => {
    const { result } = renderHook(() => useAppDeploy('app-a'));
    act(() => result.current.startDeploy());

    fire('app:deploy:output', { appId: 'app-b', text: 'other\n', stream: 'stdout' });
    fire('app:deploy:error', { appId: 'app-b', message: 'boom' });
    fire('app:deploy:complete', { appId: 'app-b', success: true, code: 0 });

    expect(result.current.isDeploying).toBe(true);
    expect(result.current.output).toEqual([]);
    expect(result.current.error).toBeNull();
    expect(result.current.result).toBeNull();
  });

  it('settles on the terminal frame, and a trailing snapshot listing the finished run cannot resurrect it', () => {
    const { result } = renderHook(() => useAppDeploy('app-a'));
    act(() => result.current.startDeploy());
    active(liveDeploy('app-a', 1000));
    fire('app:deploy:status', { appId: 'app-a', message: 'Starting deploy...', phase: 'start' });

    fire('app:deploy:complete', { appId: 'app-a', success: true, code: 0 });
    expect(result.current.isDeploying).toBe(false);
    expect(result.current.result).toEqual({ appId: 'app-a', success: true, code: 0 });

    // A snapshot generated before the run ended arrives after its terminal frame.
    active(liveDeploy('app-a', 1000));
    expect(result.current.isDeploying).toBe(false);
    // The registry's end broadcast does not clear the tombstone: a later
    // trailing snapshot is still ignored, with no spurious lost-connection message.
    active();
    active(liveDeploy('app-a', 1000));
    expect(result.current.isDeploying).toBe(false);
    expect(result.current.error).toBeNull();
    expect(result.current.result).not.toBeNull();

    // A genuinely new run (different startedAt) is followed again.
    active(liveDeploy('app-a', 2000));
    expect(result.current.isDeploying).toBe(true);
    expect(result.current.result).toBeNull();
  });

  it('a later run listed after a finished one replaces the old log instead of keeping its output', () => {
    const { result } = renderHook(() => useAppDeploy('app-a'));
    act(() => result.current.startDeploy());
    active(liveDeploy('app-a', 1000));
    fire('app:deploy:output', { appId: 'app-a', text: 'old run\n', stream: 'stdout', timestamp: 1 });
    fire('app:deploy:complete', { appId: 'app-a', success: false, code: 1 });
    active();
    expect(result.current.output.map(o => o.text)).toEqual(['old run\n']);

    active(liveDeploy('app-a', 2000, [step('Starting deploy...')]));
    expect(result.current.isDeploying).toBe(true);
    expect(result.current.result).toBeNull();
    expect(result.current.error).toBeNull();
    expect(result.current.output.map(o => o.text)).toEqual(['--- Starting deploy... ---\n']);
  });

  it('a different run started while disconnected replaces the log on reconnect', () => {
    const { result } = renderHook(() => useAppDeploy('app-a'));
    active(liveDeploy('app-a', 1000));
    fire('app:deploy:output', { appId: 'app-a', text: 'old run\n', stream: 'stdout', timestamp: 1 });

    fire('disconnect');
    fire('connect');
    active(liveDeploy('app-a', 2000, [step('New run')]));
    expect(result.current.isDeploying).toBe(true);
    expect(result.current.error).toBeNull();
    expect(result.current.output.map(o => o.text)).toEqual(['--- New run ---\n']);

    // The reconnect is behind us; the new run's terminal frame is reliable again.
    active();
    expect(result.current.isDeploying).toBe(true);
    expect(result.current.error).toBeNull();
  });

  it('an empty snapshot while connected does not settle a confirmed live run', () => {
    const { result } = renderHook(() => useAppDeploy('app-a'));
    active(liveDeploy());
    fire('app:deploy:output', { appId: 'app-a', text: 'building\n', stream: 'stdout', timestamp: 1 });
    active();
    expect(result.current.isDeploying).toBe(true);
    expect(result.current.error).toBeNull();

    // Still waiting for the terminal frame, which then settles it.
    fire('app:deploy:complete', { appId: 'app-a', success: true, code: 0 });
    expect(result.current.isDeploying).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('keeps following the same run after a reconnect that still lists it, then waits for its terminal frame', () => {
    const { result } = renderHook(() => useAppDeploy('app-a'));
    active(liveDeploy());
    fire('app:deploy:output', { appId: 'app-a', text: 'building\n', stream: 'stdout', timestamp: 1 });
    fire('disconnect');
    fire('connect');
    active(liveDeploy());
    expect(result.current.output.map(o => o.text)).toEqual(['building\n']);
    active();
    expect(result.current.isDeploying).toBe(true);
  });

  it('a terminal error also wins over a stale snapshot', () => {
    const { result } = renderHook(() => useAppDeploy('app-a'));
    active(liveDeploy());
    fire('app:deploy:error', { appId: 'app-a', message: 'Deploy failed' });
    active(liveDeploy());
    expect(result.current.isDeploying).toBe(false);
    expect(result.current.error).toBe('Deploy failed');
  });

  it('does not read a snapshot that predates the server claim as a lost deploy', () => {
    const { result } = renderHook(() => useAppDeploy('app-a'));
    act(() => result.current.startDeploy());
    // A reconnect snapshot generated before app:deploy was processed.
    active();
    expect(result.current.isDeploying).toBe(true);
    expect(result.current.error).toBeNull();

    fire('app:deploy:status', { appId: 'app-a', message: 'Starting deploy...', phase: 'start' });
    expect(result.current.isDeploying).toBe(true);
  });

  it('does not claim a dispatch the server never acknowledged ran once the link dropped and the registry is empty', () => {
    const { result } = renderHook(() => useAppDeploy('app-a'));
    act(() => result.current.startDeploy());
    fire('disconnect');
    fire('connect');
    active();
    expect(result.current.isDeploying).toBe(false);
    expect(result.current.error).toBe(NOT_CONFIRMED);
  });

  it('keeps an unacknowledged dispatch spinning while connected, and attaches if the registry lists it after a reconnect', () => {
    const { result } = renderHook(() => useAppDeploy('app-a'));
    act(() => result.current.startDeploy());
    fire('disconnect');
    fire('connect');
    active(liveDeploy());
    expect(result.current.isDeploying).toBe(true);
    expect(result.current.error).toBeNull();

    // Once acknowledged, an empty snapshot after another drop is the finished-while-away case.
    fire('disconnect');
    fire('connect');
    active();
    expect(result.current.error).toBe(LOST);
  });

  it('reports a refused duplicate dispatch and reattaches to the deploy already running', () => {
    const { result } = renderHook(() => useAppDeploy('app-a'));
    act(() => result.current.startDeploy());
    const before = listRequests();

    fire('app:deploy:error', { appId: 'app-a', duplicate: true, message: 'An update is already running for Example App' });
    expect(result.current.isDeploying).toBe(false);
    expect(result.current.error).toBe('An update is already running for Example App');
    expect(listRequests()).toBe(before + 1);

    active(liveDeploy());
    expect(result.current.isDeploying).toBe(true);
    expect(result.current.error).toBeNull();
  });

  it('drops the duplicate refusal once the deploy already running streams a frame', () => {
    const { result } = renderHook(() => useAppDeploy('app-a'));
    act(() => result.current.startDeploy());
    fire('app:deploy:error', { appId: 'app-a', duplicate: true, message: 'A deploy is already running for Example App' });
    expect(result.current.error).toBe('A deploy is already running for Example App');

    fire('app:deploy:output', { appId: 'app-a', text: 'building\n', stream: 'stdout', timestamp: 1 });
    expect(result.current.isDeploying).toBe(true);
    expect(result.current.error).toBeNull();
  });

  it('drops the duplicate refusal when the deploy it hit completes successfully', () => {
    const { result } = renderHook(() => useAppDeploy('app-a'));
    act(() => result.current.startDeploy());
    fire('app:deploy:error', { appId: 'app-a', duplicate: true, message: 'A deploy is already running for Example App' });
    fire('app:deploy:complete', { appId: 'app-a', success: true, code: 0 });
    expect(result.current.error).toBeNull();
    expect(result.current.result).toEqual({ appId: 'app-a', success: true, code: 0 });
  });

  it('a failed completion replaces a stale duplicate refusal with the failure', () => {
    const { result } = renderHook(() => useAppDeploy('app-a'));
    act(() => result.current.startDeploy());
    fire('app:deploy:error', { appId: 'app-a', duplicate: true, message: 'A deploy is already running for Example App' });
    fire('app:deploy:complete', { appId: 'app-a', success: false, code: 1 });
    expect(result.current.error).toBe('Deploy failed');

    act(() => result.current.startDeploy());
    fire('app:deploy:error', { appId: 'app-a', duplicate: true, message: 'A deploy is already running for Example App' });
    fire('app:deploy:complete', { appId: 'app-a', success: false, code: 1, error: 'deploy.sh exited 1' });
    expect(result.current.error).toBe('deploy.sh exited 1');
  });

  it('a run that ends before any snapshot named it is tombstoned from its frames', () => {
    const { result } = renderHook(() => useAppDeploy('app-a'));
    act(() => result.current.startDeploy());
    fire('app:deploy:output', { appId: 'app-a', startedAt: 1000, text: 'building\n', stream: 'stdout', timestamp: 1 });
    fire('app:deploy:complete', { appId: 'app-a', startedAt: 1000, success: true, code: 0 });
    expect(result.current.isDeploying).toBe(false);

    // A trailing snapshot and a late frame from that run cannot resurrect it.
    active(liveDeploy('app-a', 1000));
    fire('app:deploy:output', { appId: 'app-a', startedAt: 1000, text: 'late\n', stream: 'stdout', timestamp: 2 });
    expect(result.current.isDeploying).toBe(false);
    expect(result.current.result).toMatchObject({ success: true });
    expect(result.current.output.map(o => o.text)).toEqual(['building\n']);

    // A genuinely new run still attaches.
    active(liveDeploy('app-a', 2000));
    expect(result.current.isDeploying).toBe(true);
  });

  it('a frame from a different run replaces the log of the run being followed', () => {
    const { result } = renderHook(() => useAppDeploy('app-a'));
    active(liveDeploy('app-a', 1000, [step('old')]));
    fire('app:deploy:output', { appId: 'app-a', startedAt: 2000, text: 'new\n', stream: 'stdout', timestamp: 3 });
    expect(result.current.output.map(o => o.text)).toEqual(['new\n']);
  });

  it('requests cancellation once and waits for the deploy to finish after acceptance', () => {
    const { result } = renderHook(() => useAppDeploy('app-a'));
    active(liveDeploy());
    act(() => {
      result.current.cancelDeploy();
      result.current.cancelDeploy();
    });
    expect(cancellationRequests).toEqual([{
      event: 'app:deploy:cancel', payload: { appId: 'app-a' }, callback: expect.any(Function),
    }]);
    expect(result.current.isCancelling).toBe(true);
    act(() => cancellationRequests[0].callback(null, { ok: true }));
    expect(result.current.isCancelling).toBe(true);
    expect(result.current.isDeploying).toBe(true);

    fire('app:deploy:complete', {
      appId: 'app-a', startedAt: 1000, success: false, cancelled: true, code: -1, error: 'Deploy cancelled',
    });
    expect(result.current.isCancelling).toBe(false);
    expect(result.current.isDeploying).toBe(false);
    expect(result.current.result).toMatchObject({ cancelled: true });
    expect(result.current.error).toBe('Deploy cancelled');
  });

  it.each([
    { code: 'HOST_CONTROL_REQUIRED', message: 'Host control is required' },
    { code: 'DEPLOY_CANCEL_FAILED', message: 'Could not cancel deploy' },
    { code: 'NO_ACTIVE_DEPLOY', message: 'No active deploy to cancel' },
  ])('surfaces a $code rejection and leaves the run live', ({ code, message }) => {
    const { result } = renderHook(() => useAppDeploy('app-a'));
    active(liveDeploy());
    act(() => result.current.cancelDeploy());
    act(() => cancellationRequests[0].callback(null, { ok: false, code, message }));
    expect(result.current.error).toBe(message);
    expect(result.current.isCancelling).toBe(false);
    expect(result.current.isDeploying).toBe(true);

    act(() => result.current.cancelDeploy());
    expect(result.current.isCancelling).toBe(true);
    expect(result.current.error).toBeNull();
    expect(cancellationRequests).toHaveLength(2);
  });

  it('keeps a live deploy retryable when an acknowledgement is lost and avoids queuing while disconnected', () => {
    const { result } = renderHook(() => useAppDeploy('app-a'));
    active(liveDeploy());
    act(() => result.current.cancelDeploy());
    act(() => cancellationRequests[0].callback(new Error('operation has timed out')));
    expect(result.current.error).toBe('Could not confirm deploy cancellation');
    expect(result.current.isCancelling).toBe(false);
    expect(result.current.isDeploying).toBe(true);

    socketState.connected = false;
    act(() => result.current.cancelDeploy());
    expect(result.current.error).toBe('Reconnect to cancel this deploy');
    expect(cancellationRequests).toHaveLength(1);
  });

  it('ignores a cancellation rejection after the deploy has already settled', () => {
    const { result } = renderHook(() => useAppDeploy('app-a'));
    active(liveDeploy());
    act(() => result.current.cancelDeploy());
    fire('app:deploy:complete', { appId: 'app-a', startedAt: 1000, success: true, code: 0 });
    act(() => cancellationRequests[0].callback(null, { ok: false, code: 'NO_ACTIVE_DEPLOY', message: 'No active deploy to cancel' }));
    expect(result.current.isCancelling).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('does not apply a cancellation acknowledgement after switching apps', () => {
    const { result, rerender } = renderHook(({ appId }) => useAppDeploy(appId), { initialProps: { appId: 'app-a' } });
    active(liveDeploy());
    act(() => result.current.cancelDeploy());
    rerender({ appId: 'app-b' });
    expect(result.current.isCancelling).toBe(false);

    active(liveDeploy('app-b'));
    act(() => result.current.cancelDeploy());
    act(() => cancellationRequests[0].callback(null, { ok: false, code: 'DEPLOY_CANCEL_FAILED', message: 'Could not cancel deploy' }));
    expect(result.current.isCancelling).toBe(true);
    expect(result.current.error).toBeNull();
  });

  it('preserves a streamed terminal error when the following completion omits its reason', () => {
    const { result } = renderHook(() => useAppDeploy('app-a'));
    active(liveDeploy());
    fire('app:deploy:error', { appId: 'app-a', startedAt: 1000, message: 'Deploy timed out' });
    fire('app:deploy:complete', { appId: 'app-a', startedAt: 1000, success: false, code: -1 });
    expect(result.current.error).toBe('Deploy timed out');
    expect(result.current.isDeploying).toBe(false);
  });

  it('stops listening on unmount', () => {
    const { unmount } = renderHook(() => useAppDeploy('app-a'));
    unmount();
    expect(socketHandlers.size).toBe(0);
  });
});
