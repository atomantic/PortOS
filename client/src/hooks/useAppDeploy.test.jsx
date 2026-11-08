import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';

const socketHandlers = new Map();
const emitted = [];
vi.mock('../services/socket', () => ({
  default: {
    on: (event, fn) => { socketHandlers.set(event, fn); },
    off: (event, fn) => { if (socketHandlers.get(event) === fn) socketHandlers.delete(event); },
    emit: (event, payload) => { emitted.push({ event, payload }); },
  },
}));

import { useAppDeploy } from './useAppDeploy';

const LOST = "Lost connection while this deploy ran; it has finished on the server. Check the app's logs or run Deploy again to confirm.";
const fire = (event, payload) => act(() => { socketHandlers.get(event)(payload); });
const listRequests = () => emitted.filter(e => e.event === 'app:operations:list').length;
const active = (...operations) => fire('app:operations:active', { operations });
const liveDeploy = (appId = 'app-a') => ({ appId, appName: 'Example App', type: 'deploy', steps: [] });

describe('useAppDeploy', () => {
  beforeEach(() => {
    socketHandlers.clear();
    emitted.length = 0;
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

  it('settles on the terminal frame, and a stale snapshot still listing the run cannot resurrect it', () => {
    const { result } = renderHook(() => useAppDeploy('app-a'));
    act(() => result.current.startDeploy());
    fire('app:deploy:status', { appId: 'app-a', message: 'Starting deploy...', phase: 'start' });

    fire('app:deploy:complete', { appId: 'app-a', success: true, code: 0 });
    expect(result.current.isDeploying).toBe(false);
    expect(result.current.result).toEqual({ appId: 'app-a', success: true, code: 0 });

    // A snapshot generated before the run ended arrives after its terminal frame.
    active(liveDeploy());
    expect(result.current.isDeploying).toBe(false);
    // The registry's end broadcast then arrives: no spurious lost-connection message.
    active();
    expect(result.current.isDeploying).toBe(false);
    expect(result.current.error).toBeNull();

    // After the end broadcast a new deploy elsewhere can be followed again.
    active(liveDeploy());
    expect(result.current.isDeploying).toBe(true);
    expect(result.current.result).toBeNull();
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

  it('settles a dispatch the server never acknowledged once the link dropped and the registry is empty', () => {
    const { result } = renderHook(() => useAppDeploy('app-a'));
    act(() => result.current.startDeploy());
    fire('disconnect');
    fire('connect');
    active();
    expect(result.current.isDeploying).toBe(false);
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

  it('stops listening on unmount', () => {
    const { unmount } = renderHook(() => useAppDeploy('app-a'));
    unmount();
    expect(socketHandlers.size).toBe(0);
  });
});
