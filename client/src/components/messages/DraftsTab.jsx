import { useState, useEffect, useCallback, useRef } from 'react';
import { FileText, Trash2, Send, Check, RefreshCw, Copy } from 'lucide-react';
import toast from '../ui/Toast';
import * as api from '../../services/api';
import InlineConfirmRow from '../ui/InlineConfirmRow';
import { useConfirmDelete } from '../../hooks/useConfirmDelete';
import { copyToClipboard } from '../../lib/clipboard.js';
import BrailleSpinner from '../BrailleSpinner';

function DeliveryReconciliation({ draft, onReconciled }) {
  const [checkedMailbox, setCheckedMailbox] = useState(false);
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const [error, setError] = useState(null);

  const reconcile = async (outcome) => {
    if (!checkedMailbox || pendingRef.current) return;
    pendingRef.current = true;
    setPending(true);
    setError(null);
    const result = await api.reconcileMessageDraft(draft.id, {
      attemptId: draft.sendAttemptId, outcome
    }, { silent: true }).catch(err => {
      setError(err.message || 'Could not record delivery. Refresh the draft and try again.');
      return null;
    }).finally(() => {
      pendingRef.current = false;
      setPending(false);
    });
    if (result) onReconciled(result);
  };

  return (
    <div className="rounded border border-port-warning/40 p-3 space-y-3 text-sm">
      <p className="text-port-warning">
        Delivery is unknown because this send was interrupted or the provider never
        confirmed it. It may already have reached the recipient. Check your sent mailbox
        or conversation before recording the outcome. PortOS will not resend it automatically.
      </p>
      <label className="flex items-start gap-2" htmlFor={`checked-mailbox-${draft.id}`}>
        <input id={`checked-mailbox-${draft.id}`} type="checkbox"
          checked={checkedMailbox} disabled={pending}
          onChange={event => setCheckedMailbox(event.target.checked)} />
        I checked the mailbox or conversation and can confirm the delivery outcome.
      </label>
      <div className="flex flex-wrap gap-2">
        <button disabled={!checkedMailbox || pending} aria-busy={pending}
          data-voice-guard="confirm" onClick={() => reconcile('sent')}
          className="min-h-[44px] px-3 rounded bg-port-success/20 text-port-success disabled:opacity-50">
          Confirm sent
        </button>
        <button disabled={!checkedMailbox || pending} aria-busy={pending}
          data-voice-guard="confirm" onClick={() => reconcile('not_sent')}
          className="min-h-[44px] px-3 rounded bg-port-warning/20 text-port-warning disabled:opacity-50">
          Confirm not sent
        </button>
      </div>
      <p className="text-gray-400">Confirmed sent is final. Confirmed not sent restores a draft that needs fresh approval before sending.</p>
      {error && <p role="alert" className="text-port-error">{error}</p>}
    </div>
  );
}

export default function DraftsTab({ accounts }) {
  const [drafts, setDrafts] = useState([]);
  const [loading, setLoading] = useState(true);
  const sendingRef = useRef(new Set());
  const [sendingIds, setSendingIds] = useState(new Set());
  const [copiedId, setCopiedId] = useState(null);
  const { isConfirming, requestDelete, cancelDelete, confirmDelete } = useConfirmDelete();

  const handleCopy = async (draft) => {
    // null → suppress the helper's success toast (we show a "Copied" checkmark);
    // the helper still owns the single failure toast.
    const ok = await copyToClipboard(draft.body || '', null);
    if (!ok) return;
    setCopiedId(draft.id);
    setTimeout(() => setCopiedId((prev) => (prev === draft.id ? null : prev)), 1500);
  };

  const fetchDrafts = useCallback(async () => {
    setLoading(true);
    const data = await api.getMessageDrafts().catch(() => []);
    setDrafts(data || []);
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchDrafts();
  }, [fetchDrafts]);

  const handleApprove = async (id) => {
    const result = await api.approveMessageDraft(id).catch(() => null);
    if (!result) return;
    setDrafts(prev => prev.map(d => d.id === id ? { ...d, status: 'approved' } : d));
    toast.success('Draft approved');
  };

  const handleSend = async (id) => {
    if (sendingRef.current.has(id)) return;
    sendingRef.current.add(id);
    setSendingIds(new Set(sendingRef.current));
    const result = await api.sendMessageDraft(id).catch(() => null).finally(() => {
      sendingRef.current.delete(id);
      setSendingIds(new Set(sendingRef.current));
    });
    if (!result || result.success === false) {
      // The server has already moved the draft out of "approved" — to failed, or to
      // delivery unknown when the provider never confirmed — so show that state now.
      if (!result) fetchDrafts();
      return;
    }
    setDrafts(prev => prev.map(d => d.id === id ? { ...d, status: 'sent' } : d));
    toast.success('Message sent');
  };

  const handleDelete = async (id) => {
    const ok = await api.deleteMessageDraft(id).then(() => true).catch(() => false);
    if (!ok) return;
    setDrafts(prev => prev.filter(d => d.id !== id));
    toast.success('Draft deleted');
  };

  const getAccountName = (accountId) => {
    const account = accounts.find(a => a.id === accountId);
    // Tribe-outreach drafts (#2158) for iMessage/Signal have no message account.
    if (!account) return accountId ? 'Unknown' : 'Tribe outreach';
    return account.name;
  };

  const isCopyOnly = draft => draft.sendVia === 'review' ||
    accounts.find(account => account.id === draft.accountId)?.canSend === false;

  const statusColors = {
    draft: 'bg-gray-700 text-gray-300',
    pending_review: 'bg-port-warning/20 text-port-warning',
    approved: 'bg-port-success/20 text-port-success',
    sending: 'bg-port-accent/20 text-port-accent',
    delivery_unknown: 'bg-port-warning/20 text-port-warning',
    sent: 'bg-port-success/20 text-port-success',
    failed: 'bg-port-error/20 text-port-error'
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-white">Drafts</h2>
        <button
          onClick={fetchDrafts}
          aria-label="Refresh drafts"
          className="p-2 text-gray-400 hover:text-white transition-colors"
        >
          <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>

      {loading && drafts.length === 0 && (
        <div className="text-center py-12 text-gray-400">
          <BrailleSpinner text="Loading drafts…" />
        </div>
      )}

      {drafts.length === 0 && !loading && (
        <div className="text-center py-12 text-gray-500">
          <FileText size={48} className="mx-auto mb-4 opacity-50" />
          <p>No drafts</p>
          <p className="text-sm mt-1">Generate AI replies from the Inbox or create manual drafts</p>
        </div>
      )}

      <div className="space-y-2">
        {drafts.map((draft) => (
          <div
            key={draft.id}
            className="p-4 bg-port-card rounded-lg border border-port-border space-y-2"
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className={`px-2 py-0.5 rounded text-xs ${statusColors[draft.status] || ''}`}>
                  {draft.status === 'delivery_unknown' ? 'Delivery unknown' : draft.status}
                </span>
                <span className="text-xs text-gray-500">{getAccountName(draft.accountId)}</span>
                {draft.generatedBy === 'ai' && (
                  <span className="text-xs text-port-accent-2">AI generated</span>
                )}
              </div>
              <div className="flex items-center gap-2">
                {draft.status === 'draft' && !isCopyOnly(draft) && (
                  <button
                    onClick={() => handleApprove(draft.id)}
                    className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center p-1 text-gray-400 hover:text-port-success transition-colors"
                    title="Approve" aria-label="Approve"
                  >
                    <Check size={16} />
                  </button>
                )}
                {/* Review-only drafts (e.g. Tribe outreach for iMessage/Signal,
                    which have no programmatic send channel) never offer Send —
                    messageSender can't deliver them, so the button would only
                    fail. Send them yourself from the Messages/Signal app. */}
                {draft.status === 'approved' && !isCopyOnly(draft) && (
                  <button
                    onClick={() => handleSend(draft.id)}
                    className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center p-1 text-gray-400 hover:text-port-accent transition-colors"
                    title="Send" aria-label="Send"
                    disabled={sendingIds.has(draft.id)}
                    aria-busy={sendingIds.has(draft.id)}
                    data-voice-guard="confirm"
                  >
                    {sendingIds.has(draft.id) ? <RefreshCw size={16} className="animate-spin" /> : <Send size={16} />}
                  </button>
                )}
                {isCopyOnly(draft) && (
                  <>
                    <span className="text-xs text-gray-500" title="No programmatic send — copy and send from your messaging app">
                      {draft.sendVia === 'review' ? 'Review only' : "Sending from this account isn't supported yet — copy the draft"}
                    </span>
                    <button
                      onClick={() => handleCopy(draft)}
                      className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center p-1 text-gray-400 hover:text-port-accent transition-colors"
                      title="Copy message"
                      aria-label="Copy message"
                    >
                      {copiedId === draft.id ? <Check size={16} /> : <Copy size={16} />}
                    </button>
                  </>
                )}
                {/* Review-only drafts never reach a 'sent' state (there's no send
                    channel), so keep Delete available at any status — otherwise an
                    approved iMessage/Signal draft would be stuck with no action. */}
                {(['draft', 'pending_review', 'failed'].includes(draft.status) || isCopyOnly(draft)) && (
                  <button
                    onClick={() => requestDelete(draft.id)}
                    className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center p-1 text-gray-400 hover:text-port-error transition-colors"
                    title="Delete" aria-label="Delete"
                  >
                    <Trash2 size={16} />
                  </button>
                )}
              </div>
            </div>
            <div className="text-sm text-white">{draft.subject || '(no subject)'}</div>
            {draft.to?.length > 0 && (
              <div className="text-xs text-gray-500">To: {draft.to.join(', ')}</div>
            )}
            {/* Review-only drafts are sent by hand, so show the full body (not
                clamped) — it's the text the user copies into their messaging app. */}
            <div className={`text-sm text-gray-400 whitespace-pre-wrap ${isCopyOnly(draft) ? '' : 'line-clamp-3'}`}>
              {draft.body}
            </div>
            {draft.status === 'delivery_unknown' && (
              <DeliveryReconciliation key={draft.sendAttemptId} draft={draft}
                onReconciled={updated => setDrafts(prev => prev.map(d =>
                  d.id === updated.id && d.sendAttemptId === updated.sendAttemptId ? updated : d
                ))} />
            )}
            {isConfirming(draft.id) && (
              <InlineConfirmRow
                question="Delete this draft? This cannot be undone."
                confirmText="Delete"
                confirmTitle="Delete draft"
                cancelTitle="Cancel"
                onConfirm={() => confirmDelete(() => handleDelete(draft.id))}
                onCancel={cancelDelete}
              />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
