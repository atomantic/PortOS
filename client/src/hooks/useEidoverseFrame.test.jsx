import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router';
import useEidoverseFrame from './useEidoverseFrame';
import { safeRemoveStorage, safeWriteStorage } from '../lib/safeStorage';

const hostUrl = 'https://world.example.com/';
const objects = [{ id: 'portos-design-v2-signal-app-example', route: '/apps' }];
function Harness({ projected = objects, onTravel } = {}) {
  const frame = useEidoverseFrame(hostUrl, projected, onTravel);
  const location = useLocation();
  return <>
    <iframe title="Test renderer" ref={frame.frameRef} onLoad={frame.onFrameLoad} />
    <output aria-label="Route">{location.pathname}</output>
    <output aria-label="Bridge status">{frame.connection.status}</output>
    <button onClick={() => frame.changeLabelVisibility('off')}>Hide labels</button>
  </>;
}
const mount = () => render(<MemoryRouter initialEntries={['/eidoverse']}><Harness /></MemoryRouter>);
const send = (source, data, extra = {}) => act(() => {
  window.dispatchEvent(new MessageEvent('message', { source, origin: new URL(hostUrl).origin, data, ...extra }));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  safeRemoveStorage('portos-eidoverse-label-visibility');
});

describe('hosted Eidoverse frame navigation', () => {
  it('resolves a pod through the local legend rather than a destination claimed by the frame', () => {
    const onTravel = vi.fn();
    const pod = { id: 'example-pod', route: '/eidoverse', travelPeerId: 'peer-example' };
    render(<MemoryRouter><Harness projected={[pod]} onTravel={onTravel} /></MemoryRouter>);
    const iframe = screen.getByTitle('Test renderer');
    const source = iframe.contentWindow;
    const post = vi.spyOn(source, 'postMessage').mockImplementation(() => {});
    fireEvent.load(iframe);
    const { nonce } = post.mock.calls.at(-1)[0];
    send(source, { type: 'eidoverse:ready', version: 1, nonce, capabilities: { portosNavigation: 1 } });
    const action = { type: 'eidoverse:navigate', version: 1, nonce, entityId: pod.id, route: pod.route, travelPeerId: 'untrusted-peer' };
    send(source, { ...action, entityId: 'foreign-pod' });
    expect(onTravel).not.toHaveBeenCalled();
    send(source, action);
    expect(onTravel).toHaveBeenCalledExactlyOnceWith('peer-example');
  });

  it('requires the hosted window, exact origin, current handshake and projected section route', () => {
    mount();
    const frame = screen.getByTitle('Test renderer');
    const source = frame.contentWindow;
    const post = vi.spyOn(source, 'postMessage').mockImplementation(() => {});
    fireEvent.load(frame);
    const [hello, origin] = post.mock.calls.at(-1);
    expect(origin).toBe('https://world.example.com');
    expect(hello).toMatchObject({ type: 'portos:connect', version: 1, labelVisibility: 'off' });
    expect(Object.keys(hello).sort()).toEqual(['capabilities', 'labelVisibility', 'nonce', 'type', 'version']);
    const navigation = { type: 'eidoverse:navigate', version: 1, nonce: hello.nonce, entityId: objects[0].id, route: '/apps' };
    send(source, navigation); // No handshake yet.
    expect(screen.getByLabelText('Route')).toHaveTextContent('/eidoverse');
    const ready = { type: 'eidoverse:ready', version: 1, nonce: hello.nonce, capabilities: { objectLabels: 1, portosNavigation: 1, labelPreferences: 1 } };
    send(source, { ...ready, version: 0 });
    send(source, navigation);
    expect(screen.getByLabelText('Route')).toHaveTextContent('/eidoverse');
    send(source, ready);
    for (const [data, extra] of [
      [navigation, { origin: 'https://attacker.example.com' }],
      [navigation, { source: window }],
      [{ ...navigation, nonce: 'old-session' }, {}],
      [{ ...navigation, version: 99 }, {}],
      [{ ...navigation, route: 'https://attacker.example.com/' }, {}],
      [{ ...navigation, route: '//attacker.example.com/' }, {}],
      [{ ...navigation, route: '/apps?redirect=https://attacker.example.com' }, {}],
      [{ ...navigation, route: '/apps/../settings' }, {}],
      [{ ...navigation, route: '/settings/database' }, {}],
      [{ ...navigation, entityId: 'foreign-object' }, {}],
    ]) {
      send(source, data, extra);
      expect(screen.getByLabelText('Route')).toHaveTextContent('/eidoverse');
    }
    fireEvent.click(screen.getByRole('button', { name: 'Hide labels' }));
    expect(post.mock.calls.at(-1)).toEqual([{
      type: 'portos:label-preference', version: 1, nonce: hello.nonce, labelVisibility: 'off',
    }, origin]);
    fireEvent.load(frame);
    const [nextHello] = post.mock.calls.at(-1);
    expect(nextHello.nonce).not.toBe(hello.nonce);
    expect(nextHello.labelVisibility).toBe('off');
    send(source, ready);
    send(source, navigation);
    expect(screen.getByLabelText('Route')).toHaveTextContent('/eidoverse');
    send(source, { ...ready, nonce: nextHello.nonce });
    send(source, { ...navigation, nonce: nextHello.nonce });
    expect(screen.getByLabelText('Route')).toHaveTextContent('/apps');
  });

  it('starts hidden even if an older visit saved always-on labels', () => {
    safeWriteStorage('portos-eidoverse-label-visibility', 'all-nearby');
    mount();
    const iframe = screen.getByTitle('Test renderer');
    const post = vi.spyOn(iframe.contentWindow, 'postMessage').mockImplementation(() => {});
    fireEvent.load(iframe);
    expect(post.mock.calls.at(-1)[0]).toMatchObject({ type: 'portos:connect', labelVisibility: 'off' });
  });

  it('marks an unresponsive older renderer unsupported without waiting in production time', () => {
    vi.useFakeTimers();
    const view = mount();
    const iframe = screen.getByTitle('Test renderer');
    vi.spyOn(iframe.contentWindow, 'postMessage').mockImplementation(() => {});
    fireEvent.load(iframe);
    act(() => vi.advanceTimersByTime(5000));
    expect(screen.getByLabelText('Bridge status')).toHaveTextContent('unsupported');
    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
