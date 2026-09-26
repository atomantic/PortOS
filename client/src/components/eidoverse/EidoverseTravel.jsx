import { useCallback, useEffect, useRef, useState } from 'react';
import { useSocketSubscription } from '../../hooks/useSocketSubscription';
import { useVisibilityEvent } from '../../hooks/useVisibilityEvent';
import socket from '../../services/socket';
import useMounted from '../../hooks/useMounted';
import { departEidoverse, getEidoverseDestinations } from '../../services/api';

export default function EidoverseTravel({ travelRef, enabled, objects = [], onDestinationsChange, beforeDeparture }) {
  const [destinations, setDestinations] = useState([]);
  const [visible, setVisible] = useState(() => document.visibilityState !== 'hidden');
  useVisibilityEvent((state) => setVisible(state !== 'hidden'));
  const watching = enabled && visible;
  const [pending, setPending] = useState(null);
  const [error, setError] = useState('');
  const generation = useRef(0);
  const lastDestinations = useRef(null);
  const busy = useRef(false);
  const mounted = useMounted();
  const fetchSequence = useRef(0);
  useEffect(() => {
    generation.current += 1;
    return () => { generation.current += 1; };
  }, [enabled]);
  const applyDestinations = useCallback((result) => {
    if (!Array.isArray(result?.destinations)) return;
    setDestinations(result.destinations);
    const fingerprint = JSON.stringify(result.destinations.map((entry) => entry.peerId).sort());
    if (lastDestinations.current === null) lastDestinations.current = fingerprint;
  }, []);
  useEffect(() => {
    if (!watching || lastDestinations.current === null) return;
    const fingerprint = JSON.stringify(destinations.map((entry) => entry.peerId).sort());
    // The parent can defer while projecting or editing. Retry when its
    // callback changes after that gate clears, without waiting for a poll
    // or another (possibly unchanged) server snapshot.
    if (fingerprint !== lastDestinations.current && onDestinationsChange?.() !== false) {
      lastDestinations.current = fingerprint;
    }
  }, [destinations, onDestinationsChange, watching]);
  const refresh = useCallback(async () => {
    const current = generation.current;
    const sequence = ++fetchSequence.current;
    await getEidoverseDestinations({ silent: true }).then((result) => {
      if (!mounted.current || generation.current !== current || sequence !== fetchSequence.current) return;
      applyDestinations(result);
    }).catch(() => {
      if (mounted.current && generation.current === current && sequence === fetchSequence.current) setDestinations([]);
    });
  }, [mounted, applyDestinations]);
  useEffect(() => {
    if (!watching) return;
    const update = (snapshot) => {
      fetchSequence.current += 1;
      applyDestinations(snapshot);
    };
    socket.on('eidoverse-travel:destinations', update);
    refresh();
    return () => {
      fetchSequence.current += 1;
      socket.off('eidoverse-travel:destinations', update);
    };
  }, [watching, refresh, applyDestinations]);
  useSocketSubscription('eidoverse-travel', {
    enabled: watching,
    onResubscribe: refresh,
  });
  const depart = useCallback(async (peerId) => {
    if (busy.current || !enabled) return;
    busy.current = true;
    const current = generation.current;
    setPending(peerId);
    setError('');
    await departEidoverse(peerId, { silent: true }).then(async ({ url }) => {
      if (!mounted.current || generation.current !== current) return;
      await beforeDeparture?.();
      if (mounted.current && generation.current === current) window.location.assign(url);
    }).catch((failure) => {
      if (mounted.current && generation.current === current) setError(failure.message || 'Guest travel failed.');
    }).finally(() => {
      busy.current = false;
      if (mounted.current) setPending(null);
    });
  }, [enabled, mounted, beforeDeparture]);
  useEffect(() => {
    travelRef.current = depart;
    return () => { travelRef.current = null; };
  }, [depart, travelRef]);
  if (!enabled || (!destinations.length && !error)) return null;
  return <div className="flex flex-wrap items-center gap-2 border-b border-port-border px-4 py-2 text-sm">
    {Boolean(destinations.length) && (
      <span className="text-gray-400">Federation Terminal · Use a pod in-world or choose a destination</span>
    )}
    {destinations.map((destination) => <button key={destination.peerId} type="button" disabled={Boolean(pending)}
      onClick={() => depart(destination.peerId)} className="min-h-10 rounded-lg border border-port-border px-3 hover:border-port-accent disabled:opacity-50">
      {pending === destination.peerId ? 'Opening guest visit…' : destination.label}
      <span className="ml-2 text-xs text-gray-400">{objects.find((object) => object.travelPeerId === destination.peerId)?.name}</span>
    </button>)}
    {error && <p role="alert" className="text-red-400">{error}</p>}
  </div>;
}
