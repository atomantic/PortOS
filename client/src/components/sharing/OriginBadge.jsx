/**
 * OriginBadge — small chip on records imported from a share bucket. Shows
 * the source display name and the bucket alias; hover/tap reveals full
 * provenance metadata.
 *
 * Props:
 *   origin: { bucketId, bucketName, source, sourceBio?, manifestId, importedAt }
 *   compact?: boolean   // icon-only chip
 */

import { Users } from 'lucide-react';

export default function OriginBadge({ origin, compact = false, className = '' }) {
  if (!origin || typeof origin !== 'object') return null;
  const { source, bucketName, sourceBio, importedAt } = origin;
  if (!source) return null;

  const importedDate = importedAt ? new Date(importedAt).toLocaleDateString() : null;
  const title = [
    `From ${source}`,
    bucketName ? `via ${bucketName}` : null,
    importedDate ? `imported ${importedDate}` : null,
    sourceBio ? `\n\n${sourceBio}` : null,
  ].filter(Boolean).join(' · ');

  return (
    <span
      className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-port-bg border border-port-border text-[10px] text-gray-400 ${className}`}
      title={title}
    >
      <Users size={10} />
      {!compact && (
        <>
          <span className="text-port-accent">{source}</span>
          {bucketName ? <span className="text-gray-600">· {bucketName}</span> : null}
        </>
      )}
    </span>
  );
}
