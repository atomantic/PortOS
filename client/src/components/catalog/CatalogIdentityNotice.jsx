import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { getInstances } from '../../services/apiSystem';
import { ingredientPath } from '../../lib/creativeLibraries';
import { peerBaseUrl } from '../../../../server/lib/peerUrl.js';

export default function CatalogIdentityNotice({ identity, type }) {
  const [params] = useSearchParams();
  const [peer, setPeer] = useState(null);
  useEffect(() => {
    let active = true;
    setPeer(null);
    if (!identity || identity.localOwner === identity.survivorOwner) return () => { active = false; };
    getInstances({ silent: true }).then(result => {
      if (active) setPeer(result?.peers?.find(item => item.instanceId === identity.survivorOwner) || null);
    }).catch(() => {});
    return () => { active = false; };
  }, [identity?.survivorOwner, identity?.localOwner]);
  if (!identity) return null;
  const canonicalPath = ingredientPath({ id: identity.survivorId, type });
  const next = new URLSearchParams(params);
  next.set('identityOperation', identity.operationId);
  const message = identity.reason === 'CATALOG_IDENTITY_FENCED'
    ? 'This identity is reserved while the owners complete or recover the agreement. Editing and generation are unavailable.'
    : identity.reason === 'CATALOG_IDENTITY_RETAINED'
      ? 'This original ID is retained for references and provenance. Edit the canonical survivor on its owner.'
      : identity.reason === 'CATALOG_IDENTITY_FOREIGN'
        ? 'Canonical content is owned by another instance. Editing and generation are unavailable here.'
        : 'This is the canonical survivor. Retained source attachments and histories remain attributed and read-only.';
  // Tailcat loopback addresses are server-local and are not browser destinations.
  const remoteUrl = peer && peer.transport !== 'tailcat' && (peer.host || peer.address) && peer.port
    ? `${peerBaseUrl(peer)}${canonicalPath}` : null;
  return <aside className="rounded border border-port-warning/40 bg-port-card p-3 space-y-2" aria-label="Shared identity ownership">
    <p className="text-sm">{message}</p>
    <p className="text-xs break-all">Canonical owner: {identity.survivorOwner} · Retained source: {identity.sourceId}</p>
    <div className="flex flex-wrap gap-3 text-sm text-port-accent">
      {identity.localOwner === identity.survivorOwner ? <Link className="inline-flex items-center min-h-[44px] underline" to={canonicalPath}>Open canonical survivor</Link>
        : remoteUrl ? <a className="inline-flex items-center min-h-[44px] underline" href={remoteUrl} target="_blank" rel="noopener noreferrer">Open canonical owner</a>
          : <Link className="inline-flex items-center min-h-[44px] underline" to="/instances">Find canonical owner in Instances</Link>}
      <Link className="inline-flex items-center min-h-[44px] underline" to={`${canonicalPath}?${next}`}>Inspect agreement and original evidence</Link>
    </div>
  </aside>;
}
