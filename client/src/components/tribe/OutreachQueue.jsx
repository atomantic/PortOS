import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { Copy, MessageSquareReply, Sparkles } from 'lucide-react';
import { getTribeOutreach, generateTribeOutreachDraft } from '../../services/apiTribe.js';
import toast from '../ui/Toast';
import ListLoadError from '../ui/ListLoadError';
import useListResource from '../../hooks/useListResource';
import { copyToClipboard } from '../../lib/clipboard.js';

const SOURCE_LABELS = {
  imessage: 'iMessage',
  signal: 'Signal',
  gmail: 'Gmail',
  outlook: 'Outlook',
  teams: 'Teams',
  message: 'Message',
  calendar: 'Calendar',
};
const sourceLabel = (source) => SOURCE_LABELS[source] || (source ? source[0].toUpperCase() + source.slice(1) : 'Message');
const agoLabel = (days) => (days <= 0 ? 'today' : days === 1 ? 'yesterday' : `${days} days ago`);

// Timeline-aware outreach (#2158): inbound messages from Tribe people you never
// replied to. Detection is server-side and LLM-free; the "Draft reply" button is
// the only path that calls a provider (user action, per the AI-provider policy).
// Nothing is ever auto-sent — the generated draft is filed for review.
const fetchOutreachThreads = () => getTribeOutreach({ silent: true }).then((result) => result?.threads || []);

export default function OutreachQueue() {
  const { items: threads, state: threadsState, error: threadsError, retry: retryThreads, setItems: setThreads } = useListResource(fetchOutreachThreads);
  // A SET of in-flight conversation keys, not a single key — with one key, starting
  // a second generation re-enables the first thread's button and a re-click fires a
  // duplicate provider call + duplicate draft.
  const [busyKeys, setBusyKeys] = useState(() => new Set());
  const [drafts, setDrafts] = useState({});
  const [copiedKey, setCopiedKey] = useState(null);
  const [highlightKey, setHighlightKey] = useState(null);
  const rowRefs = useRef({});
  // A proactive alert deep-links here as ?outreach=<conversationKey> — scroll to and
  // highlight that exact thread so clicking one of several alerts lands on it (keyed
  // by conversation, since one person can have multiple unanswered threads).
  const [searchParams] = useSearchParams();
  const outreachKey = searchParams.get('outreach');

  useEffect(() => {
    if (!outreachKey) return;
    const target = threads.find((t) => t.conversationKey === outreachKey);
    if (!target) return;
    const el = rowRefs.current[target.conversationKey];
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setHighlightKey(target.conversationKey);
    const timer = setTimeout(() => setHighlightKey((prev) => (prev === target.conversationKey ? null : prev)), 2500);
    return () => clearTimeout(timer);
  }, [outreachKey, threads]);

  const generate = async (thread) => {
    const key = thread.conversationKey;
    if (busyKeys.has(key) || drafts[key]) return; // already generating or done
    setBusyKeys((prev) => new Set(prev).add(key));
    const seed = {
      personId: thread.personId,
      source: thread.source,
      // Scopes the email grounding query to the right account (#2820) — a Gmail
      // threadId is only unique within its account.
      accountId: thread.accountId,
      threadId: thread.threadId,
      chatGuid: thread.chatGuid,
      conversationId: thread.conversationId,
      handle: thread.handle,
      lastInboundAt: thread.lastInboundAt,
    };
    const result = await generateTribeOutreachDraft(seed, { silent: true }).catch((err) => {
      // The Care Queue loaded once, so the thread may have moved on (409):
      //  - ALREADY_REPLIED: you answered it → drop the now-resolved nudge.
      //  - STALE_INBOUND: they sent a newer message → it's STILL unanswered, so
      //    refetch to pick up the latest turn rather than falsely dropping it.
      if (err?.code === 'ALREADY_REPLIED') {
        setThreads((prev) => prev.filter((t) => t.conversationKey !== key));
        toast.success(`Looks like you already replied to ${thread.personName}`);
      } else if (err?.code === 'STALE_INBOUND') {
        getTribeOutreach({ silent: true })
          .then((r) => setThreads(r?.threads || []))
          .catch(() => {});
        toast(`${thread.personName} sent a newer message — refreshed`);
      } else {
        toast.error(err.message || 'Could not generate a draft');
      }
      return null;
    });
    setBusyKeys((prev) => { const next = new Set(prev); next.delete(key); return next; });
    if (result?.draft) {
      setDrafts((prev) => ({ ...prev, [key]: result.draft }));
      toast.success(`Draft saved for ${thread.personName} — review before sending`);
    }
  };

  const copyBody = async (key, body) => {
    // Pass null to suppress the helper's success toast (we show a transient
    // "Copied" checkmark) and let it own the single failure toast.
    const ok = await copyToClipboard(body, null);
    if (ok) {
      setCopiedKey(key);
      setTimeout(() => setCopiedKey((prev) => (prev === key ? null : prev)), 1500);
    }
  };

  // A failed read must not look like "nothing is unanswered".
  if (threadsState === 'error') return <ListLoadError what="threads waiting on a reply" error={threadsError} onRetry={retryThreads} />;
  // Quiet when loading or when nothing is unanswered — the Care Queue below still
  // shows cadence nudges, so an empty outreach panel would just be noise.
  if (!threads.length) return null;

  return (
    <section className="border border-port-border bg-port-card rounded p-4">
      <div className="flex items-center gap-2">
        <MessageSquareReply size={18} className="text-port-warning" aria-hidden="true" />
        <h2 className="text-sm font-semibold text-white">Waiting on a reply</h2>
        <span className="ml-auto rounded-full bg-port-warning/20 px-2 py-0.5 text-xs text-port-warning">{threads.length}</span>
      </div>
      <p className="mt-1 text-xs text-gray-500">
        Inbound messages from your Tribe you never replied to. Drafting a reply uses your configured AI provider; nothing is sent automatically.
      </p>
      <div className="mt-3 grid gap-3">
        {threads.map((thread) => {
          const draft = drafts[thread.conversationKey];
          const busy = busyKeys.has(thread.conversationKey);
          const highlighted = highlightKey === thread.conversationKey;
          return (
            <div
              key={thread.conversationKey}
              ref={(el) => { rowRefs.current[thread.conversationKey] = el; }}
              className={`rounded border bg-port-bg p-3 transition-colors ${highlighted ? 'border-port-warning ring-1 ring-port-warning' : 'border-port-border'}`}
            >
              <div className="flex flex-wrap items-center gap-2 text-xs text-gray-500">
                <span className="font-medium text-white">{thread.personName}</span>
                <span className="rounded border border-port-border px-1.5 py-0.5">{sourceLabel(thread.source)}</span>
                <span className="ml-auto">{agoLabel(thread.daysAgo)}</span>
              </div>
              {thread.snippet && (
                <p className="mt-2 text-sm text-gray-300 line-clamp-2">“{thread.snippet}”</p>
              )}
              {!draft ? (
                <button
                  type="button"
                  onClick={() => generate(thread)}
                  disabled={busy}
                  className="mt-3 inline-flex items-center gap-2 rounded bg-port-accent px-3 py-1.5 text-sm font-medium text-black hover:bg-port-accent/90 disabled:opacity-60"
                >
                  <Sparkles size={14} aria-hidden="true" />
                  {busy ? 'Drafting…' : 'Draft reply'}
                </button>
              ) : (
                <div className="mt-3 rounded border border-port-border bg-port-card p-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-semibold uppercase tracking-wide text-port-success">Draft saved</span>
                    <button
                      type="button"
                      onClick={() => copyBody(thread.conversationKey, draft.body)}
                      className="inline-flex items-center gap-1 rounded border border-port-border px-2 py-1 text-xs text-gray-300 hover:text-white"
                    >
                      <Copy size={12} aria-hidden="true" />
                      {copiedKey === thread.conversationKey ? 'Copied' : 'Copy'}
                    </button>
                  </div>
                  {draft.subject && <p className="mt-2 text-xs text-gray-500">Subject: {draft.subject}</p>}
                  <p className="mt-2 whitespace-pre-wrap text-sm text-gray-300">{draft.body}</p>
                  <p className="mt-2 text-xs text-gray-500">Saved to Messages → Drafts for your records. Copy it here or there, then send it from your messaging app — PortOS never sends it for you.</p>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
