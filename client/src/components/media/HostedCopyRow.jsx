import { useState } from 'react';
import { CloudOff } from 'lucide-react';
import toast from '../ui/Toast';
import InlineConfirmRow from '../ui/InlineConfirmRow';
import { deleteImageHostedCopy, deleteVideoHostedCopy } from '../../services/api';
import { formatDateTime } from '../../utils/formatters';

// The provider-side id a render was made under. Runway and fal.ai have a delete call (`deletable`); the server
// stamps `<provider>DeletedAt` on the record once it succeeds. What each call removes differs, so the wording is
// per provider: Runway's removes the rendered asset but Runway keeps its request history log (with the input
// prompt and input image), fal.ai's removes the request's stored payloads and output files.
// Topaz and Gemini only record the id (a Gemini chat id is the tail of its chat URL).
const HOSTED_PROVIDERS = [
  {
    id: 'runway', label: 'Runway', idLabel: 'Runway task', idField: 'runwayTaskId', deletedField: 'runwayDeletedAt', deletable: true,
    deleteLabel: 'Delete from Runway', deletedLabel: 'Deleted', toast: 'Deleted from Runway',
    deleteTitle: "Remove the rendered asset from Runway. Runway keeps its request history log, including the input prompt and input image. The file saved in PortOS is kept.",
    confirm: "Permanently remove the rendered asset from Runway? Runway keeps its request history log, including the input prompt and input image. The saved file here is kept.",
  },
  {
    id: 'fal', label: 'fal.ai', idLabel: 'fal.ai request', idField: 'falRequestId', deletedField: 'falDeletedAt', deletable: true,
    deleteLabel: 'Delete from fal.ai', deletedLabel: 'Deleted', toast: 'Deleted from fal.ai',
    deleteTitle: "Remove this request's stored payloads and output files from fal.ai. The file saved in PortOS is kept.",
    confirm: "Permanently remove this request's stored payloads and output files from fal.ai? The saved file here is kept.",
  },
  { id: 'topaz', label: 'Topaz', idLabel: 'Topaz request', idField: 'topazRequestId' },
  { id: 'gemini', label: 'Gemini', idLabel: 'Gemini chat', idField: 'geminiChatUrl' },
];

// Deletions confirmed this session, by provider request id. The row remounts (fullscreen toggle, prev/next) and
// the hydrated record cache keeps the pre-delete record, so without this the Delete button would come back.
const confirmedDeletions = new Map();

// Provider id for the render plus a delete control for the copy the provider still hosts.
// Keyed by the parent on the item, so confirm/busy state never carries across prev/next.
export default function HostedCopyRow({ item }) {
  const [deletedAt, setDeletedAt] = useState(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const provider = HOSTED_PROVIDERS.find((p) => item.raw?.[p.idField]);
  if (!provider) return null;

  const remoteId = item.raw[provider.idField];
  const removedAt = provider.deletable ? deletedAt || confirmedDeletions.get(remoteId) || item.raw[provider.deletedField] : null;
  const canDelete = provider.deletable && !removedAt;
  const recordId = item.kind === 'video' ? item.raw.id : item.filename;
  const remove = item.kind === 'video' ? deleteVideoHostedCopy : deleteImageHostedCopy;

  const confirmDelete = async () => {
    setBusy(true);
    const result = await remove(recordId, provider.id).catch(() => null);
    setBusy(false);
    setConfirming(false);
    if (!result?.deletedAt) return;
    confirmedDeletions.set(remoteId, result.deletedAt);
    setDeletedAt(result.deletedAt);
    toast.success(provider.toast);
  };

  return (
    <div className="space-y-1.5">
      <dl className="grid grid-cols-[auto,1fr] gap-x-3 gap-y-1">
        <dt className="text-gray-500">{provider.idLabel}</dt>
        <dd className="text-gray-200 break-all">{remoteId}</dd>
        {removedAt && (
          <>
            <dt className="text-gray-500">{provider.label} request</dt>
            <dd className="text-gray-200">{provider.deletedLabel} {formatDateTime(removedAt)}</dd>
          </>
        )}
      </dl>
      {canDelete && !confirming && (
        <button
          type="button"
          onClick={() => setConfirming(true)}
          title={provider.deleteTitle}
          className="min-h-[44px] inline-flex items-center gap-1.5 px-2 py-1.5 text-xs bg-port-border/50 text-gray-200 hover:bg-port-border rounded"
        >
          <CloudOff className="w-3.5 h-3.5" /> {provider.deleteLabel}
        </button>
      )}
      {canDelete && confirming && (
        <InlineConfirmRow
          question={provider.confirm}
          confirmText={busy ? 'Deleting…' : 'Delete'}
          cancelText="Keep"
          onConfirm={busy ? undefined : confirmDelete}
          onCancel={() => !busy && setConfirming(false)}
          autoFocus
          aria-label={`Confirm: ${provider.deleteLabel}`}
        />
      )}
    </div>
  );
}
