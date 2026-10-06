import { useEffect, useState } from 'react';
import { musicVideoDevArtifactFileUrl } from '../../services/apiMusicVideo.js';

/** Pin the served version and check availability before embedding a sandboxed file. */
export default function DevArtifactPreview({ projectId, artifact, version = artifact.version, onReady }) {
  const entry = (artifact.versions || []).find(v => v.version === version) || artifact;
  const url = musicVideoDevArtifactFileUrl(projectId, artifact.id, version);
  const [response, setResponse] = useState(null);
  useEffect(() => {
    let active = true;
    fetch(url, { method: 'HEAD' }).then(result => {
      if (active) setResponse({ url, available: result.ok });
    }).catch(() => { if (active) setResponse({ url, available: false }); });
    return () => { active = false; };
  }, [url]);
  if (response?.url !== url) return <p role="status">Loading review asset…</p>;
  if (!response.available) return <p role="alert">This review asset could not be loaded. Restore or select an available Development file before approving.</p>;
  const title = `${artifact.title} v${version || 1}`;
  const props = { onLoad: () => onReady?.(true), onError: () => { onReady?.(false); setResponse({ url, available: false }); }, className: 'w-full min-w-0 rounded border border-port-border' };
  if (entry.mimeType?.startsWith('image/')) return <img {...props} src={url} alt={title} />;
  if (entry.mimeType?.startsWith('video/')) return <video {...props} onLoadedData={() => onReady?.(true)} src={url} controls playsInline preload="metadata" aria-label={title} />;
  return <iframe {...props} key={url} src={url} title={title} sandbox="allow-scripts" referrerPolicy="no-referrer" className={`${props.className} h-[55vh] bg-white`} />;
}
