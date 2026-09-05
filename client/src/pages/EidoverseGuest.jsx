import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import useEidoverseFrame from '../hooks/useEidoverseFrame';

/** Standalone guest shell: never mounts owner controls or their private API reads. */
export default function EidoverseGuest() {
  const [hostUrl, setHostUrl] = useState(null);
  const [error, setError] = useState('');
  const [left, setLeft] = useState(false);
  const frame = useEidoverseFrame(hostUrl);
  useEffect(() => {
    const controller = new AbortController();
    const ticket = window.location.hash.slice(1);
    if (!/^[a-f0-9]{48}$/.test(ticket)) {
      setError('Start a guest visit from the teleport controls on your home instance.');
      return undefined;
    }
    fetch('/api/eidoverse/travel/guest', { headers: { 'X-Eidoverse-Guest': ticket }, signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error('This guest invitation is unavailable or has expired.');
        const { host, identity } = await response.json();
        if (window.location.protocol === 'https:' && host.protocol !== 'https') throw new Error('The destination renderer needs HTTPS.');
        const url = new URL(`${host.protocol}://${window.location.hostname}:${host.port}/`);
        url.searchParams.set('guest', '1');
        for (const key of ['world', 'name', 'avatar']) url.searchParams.set(key, identity[key]);
        if (!controller.signal.aborted) setHostUrl(url.toString());
      }).catch((failure) => { if (!controller.signal.aborted) setError(failure.message); });
    return () => controller.abort();
  }, []);
  return <main className="flex h-dvh flex-col bg-port-bg text-white">
    <header className="flex flex-wrap items-center justify-between gap-3 border-b border-port-border px-4 py-3">
      <div><h1 className="font-semibold">Eidoverse guest visit</h1><p className="text-sm text-gray-400">Visitor access · Chat is visible to people and agents in this world</p></div>
      {!left && <button type="button" className="min-h-10 rounded-lg border border-port-border px-3" onClick={() => {
        setLeft(true);
        setHostUrl(null);
        if (window.history.length > 1) window.history.back();
      }}>Leave world</button>}
    </header>
    {left ? <p className="p-6">You left the guest world.</p>
      : error ? <div role="alert" className="p-6">{error} <Link to="/eidoverse" className="underline">Open this instance</Link></div>
      : hostUrl ? <iframe ref={frame.frameRef} onLoad={frame.onFrameLoad} src={hostUrl} title="Guest Eidoverse world" className="min-h-0 flex-1 border-0" allow="microphone; fullscreen; autoplay" />
        : <p role="status" className="p-6">Entering guest world…</p>}
  </main>;
}
