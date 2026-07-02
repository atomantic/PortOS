import { useEffect, useRef, useState } from 'react';
import { ExternalLink } from 'lucide-react';
import useDrawerTab from '../hooks/useDrawerTab';

// Thin host for the standalone integration-flows doc (client/public/flows.html).
// This page's ?flow= param is the source of truth for the open flow: selections
// made inside the iframe arrive via postMessage, and outside changes (⌘K, links)
// push back into the already-mounted doc — in embed mode the doc never writes
// its own URL.
export default function FlowsDoc() {
  const [flow, setFlow] = useDrawerTab('flow', null);
  const iframeRef = useRef(null);
  // Captured once: updating src after mount would reload the doc on every click.
  const [iframeSrc] = useState(() =>
    `/flows.html?embed=1${flow ? `&flow=${encodeURIComponent(flow)}` : ''}`
  );

  useEffect(() => {
    const onMessage = (event) => {
      if (event.origin !== window.location.origin) return;
      if (event.data?.type !== 'flows:select') return;
      setFlow(event.data.flow || null);
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [setFlow]);

  useEffect(() => {
    iframeRef.current?.contentWindow?.postMessage(
      { type: 'flows:select', flow },
      window.location.origin
    );
  }, [flow]);

  return (
    <div className="absolute inset-0 flex flex-col">
      <div className="flex items-center justify-between px-4 py-2 border-b border-port-border flex-none">
        <h1 className="text-lg font-semibold">Integration Flows</h1>
        <a
          href={`/flows.html${flow ? `?flow=${encodeURIComponent(flow)}` : ''}`}
          target="_blank"
          rel="noreferrer"
          className="flex items-center gap-1.5 text-sm text-port-accent hover:underline"
        >
          <ExternalLink size={14} />
          Open full screen
        </a>
      </div>
      <iframe
        ref={iframeRef}
        title="PortOS integration flows"
        src={iframeSrc}
        className="flex-1 w-full border-0"
      />
    </div>
  );
}
