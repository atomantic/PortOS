import { useEffect } from 'react';
import socket from '../services/socket';
import toast from '../components/ui/Toast';

const shareSender = (payload) => {
  const source = payload.source || 'a peer';
  return payload.producedByVersion && payload.producedByVersion !== 'unknown'
    ? `${source} (PortOS ${payload.producedByVersion})`
    : source;
};

/**
 * Global subscriber for share-bucket notifications. Mirrors useErrorNotifications:
 * mounts once in Layout.jsx so any open page hears about auto-merge updates
 * regardless of where the user is in the app.
 *
 * The Sharing page itself does NOT need to toast — it already lists incoming
 * activity in its own UI. We suppress the toast when the user is on /sharing
 * to avoid the duplicate.
 */
export function useSharingNotifications() {
  useEffect(() => {
    const onManifestProcessed = (payload) => {
      const overridden = payload?.outcome?.overridden;
      if (!Array.isArray(overridden) || overridden.length === 0) return;
      if (typeof window !== 'undefined' && window.location?.pathname?.startsWith('/sharing')) return;
      const labels = overridden
        .slice(0, 3)
        .map((o) => `${o.kind === 'issue' ? 'Issue' : o.kind === 'universe' ? 'Universe' : 'Series'} "${o.label || o.id}"`);
      const more = overridden.length > 3 ? ` (+${overridden.length - 3} more)` : '';
      toast(`Auto-merged: ${labels.join(', ')}${more}`, {
        icon: '🔄',
        duration: 8000,
      });
    };
    const onIncompatibleManifest = (payload) => {
      if (!payload) return;
      toast.error(
        `Can't import share from ${shareSender(payload)} — protocol v${payload.remoteVersion} requires upgrading PortOS (local v${payload.localVersion}).`,
        { duration: 12000 },
      );
    };
    const onSchemaAhead = (payload) => {
      if (!payload) return;
      const categories = (payload.ahead || []).map((gap) => gap.category).join(', ') || 'storage';
      toast.error(
        `Can't import share from ${shareSender(payload)} yet — it uses a newer ${categories} format. Update PortOS and it imports automatically.`,
        { duration: 12000 },
      );
    };
    socket.on('sharing:manifest-processed', onManifestProcessed);
    socket.on('sharing:incompatible-manifest', onIncompatibleManifest);
    socket.on('sharing:portos-schema-ahead', onSchemaAhead);
    return () => {
      socket.off('sharing:manifest-processed', onManifestProcessed);
      socket.off('sharing:incompatible-manifest', onIncompatibleManifest);
      socket.off('sharing:portos-schema-ahead', onSchemaAhead);
    };
  }, []);
}
