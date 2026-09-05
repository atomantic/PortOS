import { useCallback, useEffect, useRef, useState } from 'react';
import { useAutoRefetch } from '../../hooks/useAutoRefetch';
import useMounted from '../../hooks/useMounted';
import { departEidoverse, getEidoverseDestinations } from '../../services/api';

export default function EidoverseTravel({ travelRef, enabled, objects = [], onDestinationsChange, beforeDeparture }) {
  const [destinations, setDestinations] = useState([]);
  const [pending, setPending] = useState(null);
  const [error, setError] = useState('');
  const generation = useRef(0);
  const destinationsChanged = useRef(onDestinationsChange);
  destinationsChanged.current = onDestinationsChange;
  const lastDestinations = useRef(null);
  const busy = useRef(false);
  const mounted = useMounted();
  const fetchSequence = useRef(0);
  useEffect(() => {
    generation.current += 1;
    return () => { generation.current += 1; };
  }, [enabled]);
  const refresh = useCallback(async () => {
    const current = generation.current;
    const sequence = ++fetchSequence.current;
    await getEidoverseDestinations({ silent: true }).then((result) => {
      if (!mounted.current || generation.current !== current || sequence !== fetchSequence.current) return;
      setDestinations(result.destinations);
      const fingerprint = JSON.stringify(result.destinations.map((entry) => entry.peerId).sort());
      if (lastDestinations.current === null || fingerprint === lastDestinations.current
        || destinationsChanged.current?.() !== false) lastDestinations.current = fingerprint;
    }).catch(() => {
      if (mounted.current && generation.current === current && sequence === fetchSequence.current) setDestinations([]);
    });
  }, [mounted]);
  useAutoRefetch(refresh, 30000, { enabled, pollOnly: true });
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
  if (!enabled) return null;
  return <div className="flex flex-wrap items-center gap-2 border-b border-port-border px-4 py-2 text-sm">
    <span className="text-gray-400">Federation Terminal · Use a pod in-world or choose a destination</span>
    {destinations.map((destination) => <button key={destination.peerId} type="button" disabled={Boolean(pending)}
      onClick={() => depart(destination.peerId)} className="min-h-10 rounded-lg border border-port-border px-3 hover:border-port-accent disabled:opacity-50">
      {pending === destination.peerId ? 'Opening guest visit…' : destination.label}
      <span className="ml-2 text-xs text-gray-400">{objects.find((object) => object.travelPeerId === destination.peerId)?.name}</span>
    </button>)}
    {!destinations.length && <span className="text-gray-500">No connected guest worlds available</span>}
    {error && <p role="alert" className="text-red-400">{error}</p>}
  </div>;
}
