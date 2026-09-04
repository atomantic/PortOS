import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import {
  AlertTriangle,
  Calendar,
  Clock,
  Copy,
  Edit3,
  Filter,
  Heart,
  MessageCircle,
  MessageSquareReply,
  Network,
  Orbit,
  Plus,
  Save,
  Search,
  Sparkles,
  Trash2,
  UserRound,
  Users,
  X,
} from 'lucide-react';

import * as api from '../services/api';
import socket from '../services/socket';
import BrailleSpinner from '../components/BrailleSpinner';
import Banner from '../components/ui/Banner';
import PageHeader from '../components/PageHeader';
import { localDateStr } from '../components/meatspace/constants';
import toast from '../components/ui/Toast';
import TabPills from '../components/ui/TabPills';
import TribeCircleMap from '../components/tribe/TribeCircleMap.jsx';
import { copyToClipboard } from '../lib/clipboard.js';
import { safeReadStorage, safeRemoveStorage } from '../lib/safeStorage.js';
import {
  RINGS,
  ENERGY,
  STATUS_FILTER_IDS,
  STATUS_FILTER_LABELS,
  contactStatus,
  matchesStatusFilter,
  ringFor,
  energyFor,
  tagsToArray,
  tagsToInput,
} from '../lib/tribe.js';

const STORAGE_KEY = 'portos-tribe-v1';

// Care Queue leads: the page's headline metric is the overdue count, so arrival
// lands on the people who need a touch (each row carries the Touch button) rather
// than on the full roster (#3791).
const TABS = [
  { id: 'care', label: 'Care Queue', icon: Clock },
  { id: 'circle', label: 'Circle', icon: Network },
  { id: 'map', label: 'Map', icon: Orbit },
  { id: 'focus', label: 'Focus', icon: Heart },
];

const TAB_IDS = TABS.map((tab) => tab.id);
const DEFAULT_TAB = 'care';
const DEFAULT_STATUS = 'all';

const emptyDraft = () => ({
  id: null,
  name: '',
  relationship: '',
  ring: 'tribe',
  cadenceDays: 45,
  lastContact: '',
  channel: '',
  energy: 'steady',
  tags: '',
  emails: '',
  phones: '',
  nextMove: '',
  notes: '',
});

// Default values are omitted from the URL so `/tribe` stays clean.
function withParam(params, key, value, defaultValue) {
  if (value === defaultValue) params.delete(key);
  else params.set(key, value);
  return params;
}

function parseStoredContacts(value) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function getLegacyContacts() {
  return parseStoredContacts(safeReadStorage(STORAGE_KEY));
}

function clearLegacyContacts() {
  safeRemoveStorage(STORAGE_KEY);
}

// A tile that names the user's task (`Needs Care`) is the fastest route into it,
// so tiles with an `onClick` render as real buttons that filter the list; the
// rest stay inert text (#3791).
function StatTile({ icon: Icon, label, value, detail, onClick, active = false, className = '' }) {
  const body = (
    <div className="flex items-start justify-between gap-2">
      <div className="min-w-0">
        <p className="text-xs uppercase tracking-wide text-gray-500">{label}</p>
        <p className="mt-1 text-xl font-semibold text-white sm:text-2xl">{value}</p>
        {detail && <p className="mt-1 text-xs text-gray-500 truncate">{detail}</p>}
      </div>
      <Icon size={20} className="shrink-0 text-port-accent" aria-hidden="true" />
    </div>
  );
  const base = `rounded p-3 min-w-0 text-left sm:p-4 bg-port-card border ${className}`;

  if (!onClick) {
    return <div className={`${base} border-port-border`}>{body}</div>;
  }

  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`${base} w-full transition-colors ${active ? 'border-port-accent/70 ring-1 ring-port-accent/30' : 'border-port-border hover:border-port-accent/50'}`}
    >
      {body}
    </button>
  );
}

function RingMeter({ ring, contacts, active, onClick }) {
  const count = contacts.filter((contact) => contact.ring === ring.id).length;
  // `external` is uncapped (cap === null): show a count only, no fill bar or
  // cadence, since it's outside the tribe and carries no care commitment.
  const uncapped = ring.cap == null;
  const fill = uncapped ? 0 : Math.min(100, Math.round((count / ring.cap) * 100));
  return (
    <button
      type="button"
      onClick={onClick}
      className={`w-full text-left border rounded p-4 transition-colors ${ring.bg} ${active ? `${ring.border} ring-1 ring-port-accent/30` : 'border-port-border hover:border-port-accent/50'}`}
    >
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className={`text-sm font-semibold ${ring.tone}`}>{ring.label}</p>
          <p className="text-xs text-gray-500">{uncapped ? `${count}` : `${count} / ${ring.cap}`}</p>
        </div>
        <span className="text-xs text-gray-400">{uncapped ? 'outside tribe' : `${ring.cadenceDays}d`}</span>
      </div>
      {!uncapped && (
        <div className="mt-3 h-2 rounded-full bg-black/30 overflow-hidden">
          <div className="h-full rounded-full bg-current text-port-accent" style={{ width: `${fill}%` }} />
        </div>
      )}
    </button>
  );
}

function ContactCard({ contact, active, onSelect, onLogTouch }) {
  const ring = ringFor(contact.ring);
  const energy = energyFor(contact.energy);
  const status = contactStatus(contact);
  const tags = tagsToArray(contact.tags).slice(0, 3);

  return (
    <article
      className={`w-full text-left border rounded p-4 transition-colors bg-port-card ${
        active ? 'border-port-accent/70 ring-1 ring-port-accent/30' : 'border-port-border hover:border-port-accent/40'
      }`}
    >
      <button type="button" onClick={onSelect} className="block w-full text-left">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2 min-w-0">
              <UserRound size={16} className="shrink-0 text-gray-500" aria-hidden="true" />
              <h3 className="font-semibold text-white truncate">{contact.name || 'Unnamed person'}</h3>
            </div>
            <p className="mt-1 text-sm text-gray-400 truncate">{contact.relationship || 'Relationship'}</p>
          </div>
          <span className={`shrink-0 rounded border px-2 py-1 text-xs ${ring.bg} ${ring.border} ${ring.tone}`}>
            {ring.label}
          </span>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <span className={`rounded border px-2 py-1 text-xs ${energy.className}`}>{energy.label}</span>
          <span className={`text-xs ${status.tone}`}>{status.label}</span>
          {contact.channel && <span className="text-xs text-gray-500">{contact.channel}</span>}
        </div>

        {tags.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-1.5">
            {tags.map((tag) => (
              <span key={tag} className="rounded bg-port-bg px-2 py-1 text-[11px] text-gray-400">{tag}</span>
            ))}
          </div>
        )}

        {contact.nextMove && (
          <p className="mt-3 text-sm text-gray-300 line-clamp-2">{contact.nextMove}</p>
        )}
      </button>

      <div className="mt-4 flex items-center justify-between gap-3 text-xs text-gray-500">
        <span>{contact.lastContact ? `Last ${contact.lastContact}` : 'No date logged'}</span>
        <button
          type="button"
          onClick={onLogTouch}
          className="inline-flex items-center gap-1 rounded px-2 py-1 text-port-accent hover:bg-port-accent/10"
        >
          <MessageCircle size={13} aria-hidden="true" />
          Touch
        </button>
      </div>
    </article>
  );
}

function ContactForm({ draft, onChange, onSave, onDelete, onNew, isExisting, saving, nameInputRef, formRef }) {
  const update = (field, value) => onChange({ ...draft, [field]: value });

  return (
    <form
      ref={formRef}
      className="border border-port-border bg-port-card rounded p-4"
      onSubmit={(event) => {
        event.preventDefault();
        onSave();
      }}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <Edit3 size={18} className="text-port-accent shrink-0" aria-hidden="true" />
          <h2 className="text-sm font-semibold text-white truncate">{isExisting ? 'Relationship' : 'New Relationship'}</h2>
        </div>
        <button
          type="button"
          onClick={onNew}
          title="New relationship"
          aria-label="New relationship"
          className="inline-flex h-9 w-9 items-center justify-center rounded border border-port-border text-gray-300 hover:text-white hover:bg-port-border/40"
        >
          <Plus size={16} aria-hidden="true" />
        </button>
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <label className="block">
          <span className="text-xs text-gray-500">Name</span>
          <input
            ref={nameInputRef}
            value={draft.name}
            onChange={(event) => update('name', event.target.value)}
            className="mt-1 w-full rounded border border-port-border bg-port-bg px-3 py-2 text-sm text-white outline-none focus:border-port-accent"
            placeholder="Person"
          />
        </label>
        <label className="block">
          <span className="text-xs text-gray-500">Relationship</span>
          <input
            value={draft.relationship}
            onChange={(event) => update('relationship', event.target.value)}
            className="mt-1 w-full rounded border border-port-border bg-port-bg px-3 py-2 text-sm text-white outline-none focus:border-port-accent"
            placeholder="Friend, mentor, family"
          />
        </label>
        <label className="block">
          <span className="text-xs text-gray-500">Ring</span>
          <select
            value={draft.ring}
            onChange={(event) => {
              const ring = ringFor(event.target.value);
              onChange({ ...draft, ring: ring.id, cadenceDays: ring.cadenceDays });
            }}
            className="mt-1 w-full rounded border border-port-border bg-port-bg px-3 py-2 text-sm text-white outline-none focus:border-port-accent"
          >
            {RINGS.map((ring) => <option key={ring.id} value={ring.id}>{ring.label}</option>)}
          </select>
        </label>
        <label className="block">
          <span className="text-xs text-gray-500">Cadence</span>
          <input
            type="number"
            min="1"
            value={draft.cadenceDays}
            onChange={(event) => update('cadenceDays', event.target.value)}
            className="mt-1 w-full rounded border border-port-border bg-port-bg px-3 py-2 text-sm text-white outline-none focus:border-port-accent"
          />
        </label>
        <label className="block">
          <span className="text-xs text-gray-500">Last Contact</span>
          <input
            type="date"
            value={draft.lastContact}
            onChange={(event) => update('lastContact', event.target.value)}
            className="mt-1 w-full rounded border border-port-border bg-port-bg px-3 py-2 text-sm text-white outline-none focus:border-port-accent"
          />
        </label>
        <label className="block">
          <span className="text-xs text-gray-500">Energy</span>
          <select
            value={draft.energy}
            onChange={(event) => update('energy', event.target.value)}
            className="mt-1 w-full rounded border border-port-border bg-port-bg px-3 py-2 text-sm text-white outline-none focus:border-port-accent"
          >
            {ENERGY.map((energy) => <option key={energy.id} value={energy.id}>{energy.label}</option>)}
          </select>
        </label>
        <label className="block sm:col-span-2">
          <span className="text-xs text-gray-500">Channel</span>
          <input
            value={draft.channel}
            onChange={(event) => update('channel', event.target.value)}
            className="mt-1 w-full rounded border border-port-border bg-port-bg px-3 py-2 text-sm text-white outline-none focus:border-port-accent"
            placeholder="Text, call, dinner, walk"
          />
        </label>
        <label className="block sm:col-span-2">
          <span className="text-xs text-gray-500">Tags</span>
          <input
            value={draft.tags}
            onChange={(event) => update('tags', event.target.value)}
            className="mt-1 w-full rounded border border-port-border bg-port-bg px-3 py-2 text-sm text-white outline-none focus:border-port-accent"
            placeholder="comma, separated"
          />
        </label>
        <label className="block sm:col-span-2">
          <span className="text-xs text-gray-500">Emails &amp; handles</span>
          <input
            value={draft.emails}
            onChange={(event) => update('emails', event.target.value)}
            className="mt-1 w-full rounded border border-port-border bg-port-bg px-3 py-2 text-sm text-white outline-none focus:border-port-accent"
            placeholder="jane@work.com, jane@home.com"
          />
          <span className="mt-1 block text-[11px] text-gray-600">
            Auto-logs a touchpoint when this person appears in a synced calendar event or message.
          </span>
        </label>
        <label className="block sm:col-span-2">
          <span className="text-xs text-gray-500">Phone numbers</span>
          <input
            value={draft.phones}
            onChange={(event) => update('phones', event.target.value)}
            className="mt-1 w-full rounded border border-port-border bg-port-bg px-3 py-2 text-sm text-white outline-none focus:border-port-accent"
            placeholder="+1 555 123 4567, 555 987 6543"
          />
          <span className="mt-1 block text-[11px] text-gray-600">
            Matches this person to iMessage conversations (saved in +E.164 form).
          </span>
        </label>
        <label className="block sm:col-span-2">
          <span className="text-xs text-gray-500">Next Move</span>
          <textarea
            value={draft.nextMove}
            onChange={(event) => update('nextMove', event.target.value)}
            rows={2}
            className="mt-1 w-full rounded border border-port-border bg-port-bg px-3 py-2 text-sm text-white outline-none focus:border-port-accent"
            placeholder="A concrete next touchpoint"
          />
        </label>
        <label className="block sm:col-span-2">
          <span className="text-xs text-gray-500">Notes</span>
          <textarea
            value={draft.notes}
            onChange={(event) => update('notes', event.target.value)}
            rows={4}
            className="mt-1 w-full rounded border border-port-border bg-port-bg px-3 py-2 text-sm text-white outline-none focus:border-port-accent"
            placeholder="Context worth remembering"
          />
        </label>
      </div>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
        <button
          type="submit"
          disabled={saving}
          className="inline-flex items-center gap-2 rounded bg-port-accent px-3 py-2 text-sm font-medium text-black hover:bg-port-accent/90"
        >
          <Save size={15} aria-hidden="true" />
          {saving ? 'Saving' : 'Save'}
        </button>
        {isExisting && (
          <button
            type="button"
            onClick={onDelete}
            className="inline-flex items-center gap-2 rounded border border-rose-500/40 px-3 py-2 text-sm text-rose-300 hover:bg-rose-500/10"
          >
            <Trash2 size={15} aria-hidden="true" />
            Delete
          </button>
        )}
      </div>
    </form>
  );
}

function MemoryLinksPanel({ personId }) {
  const [links, setLinks] = useState([]);
  const [memories, setMemories] = useState([]);
  const [memoryId, setMemoryId] = useState('');
  const [note, setNote] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!personId) return;
    let cancelled = false;
    setLoading(true);
    Promise.all([
      api.getTribeMemoryLinks(personId).catch(() => ({ links: [] })),
      api.getMemories({ limit: 25, sortBy: 'updatedAt', sortOrder: 'desc' }).catch(() => ({ memories: [] })),
    ]).then(([linkResult, memoryResult]) => {
      if (cancelled) return;
      setLinks(linkResult?.links || []);
      setMemories(memoryResult?.memories || []);
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [personId]);

  const linkMemory = async () => {
    if (!memoryId) return;
    const result = await api.linkTribeMemory(personId, { memoryId, note }, { silent: true }).catch((err) => {
      toast.error(err.message || 'Failed to link memory');
      return null;
    });
    if (!result) return;
    setLinks(result.links || []);
    setMemoryId('');
    setNote('');
  };

  const unlinkMemory = async (id) => {
    const result = await api.unlinkTribeMemory(personId, id, { silent: true }).catch((err) => {
      toast.error(err.message || 'Failed to unlink memory');
      return null;
    });
    if (!result?.success) return;
    setLinks((current) => current.filter((link) => link.memoryId !== id));
  };

  return (
    <section className="mt-4 border border-port-border bg-port-card rounded p-4">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold text-white">Brain Memories</h2>
        {loading && <span className="text-xs text-gray-500">Loading</span>}
      </div>
      <div className="mt-3 grid gap-2">
        <select
          aria-label="Brain memory"
          value={memoryId}
          onChange={(event) => setMemoryId(event.target.value)}
          className="w-full rounded border border-port-border bg-port-bg px-3 py-2 text-sm text-white outline-none focus:border-port-accent"
        >
          <option value="">Select recent memory</option>
          {memories.map((memory) => (
            <option key={memory.id} value={memory.id}>{memory.summary || memory.id}</option>
          ))}
        </select>
        <input
          value={note}
          onChange={(event) => setNote(event.target.value)}
          aria-label="Why this memory matters"
          className="w-full rounded border border-port-border bg-port-bg px-3 py-2 text-sm text-white outline-none focus:border-port-accent"
          placeholder="Why this memory matters"
        />
        <button
          type="button"
          onClick={linkMemory}
          disabled={!memoryId}
          className="inline-flex items-center justify-center gap-2 rounded border border-port-border px-3 py-2 text-sm text-gray-300 hover:bg-port-border/40 hover:text-white disabled:opacity-50"
        >
          <Plus size={15} aria-hidden="true" />
          Link Memory
        </button>
      </div>

      <div className="mt-4 grid gap-2">
        {links.length ? links.map((link) => (
          <div key={link.memoryId} className="rounded border border-port-border bg-port-bg p-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm font-medium text-white line-clamp-2">{link.memory?.summary || link.memoryId}</p>
                {link.note && <p className="mt-1 text-xs text-gray-500">{link.note}</p>}
              </div>
              <button
                type="button"
                onClick={() => unlinkMemory(link.memoryId)}
                title="Unlink memory"
                aria-label="Unlink memory"
                className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center shrink-0 rounded p-1 text-gray-500 hover:text-rose-300"
              >
                <X size={14} aria-hidden="true" />
              </button>
            </div>
          </div>
        )) : (
          <p className="text-sm text-gray-500">No memories linked yet.</p>
        )}
      </div>
    </section>
  );
}

// Icon + label per touchpoint source so an auto-logged calendar/message
// touchpoint is visually distinct from a hand-logged one (#2033).
const SOURCE_BADGES = {
  calendar: { Icon: Calendar, label: 'Calendar' },
  message: { Icon: MessageCircle, label: 'Message' },
  imessage: { Icon: MessageCircle, label: 'iMessage' },
  import: { Icon: Users, label: 'Import' },
  user: { Icon: UserRound, label: 'Manual' },
};

function TouchpointSource({ source }) {
  const badge = SOURCE_BADGES[source] || SOURCE_BADGES.user;
  const { Icon, label } = badge;
  return (
    <span className="inline-flex items-center gap-1" title={`Source: ${label}`}>
      <Icon size={12} aria-hidden="true" />
      {label}
    </span>
  );
}

function TouchpointsPanel({ personId }) {
  const [touchpoints, setTouchpoints] = useState([]);

  useEffect(() => {
    if (!personId) return;
    let cancelled = false;
    api.getTribeTouchpoints(personId, 8)
      .then((result) => { if (!cancelled) setTouchpoints(result?.touchpoints || []); })
      .catch(() => { if (!cancelled) setTouchpoints([]); });
    return () => { cancelled = true; };
  }, [personId]);

  if (!personId) return null;

  return (
    <section className="mt-4 border border-port-border bg-port-card rounded p-4">
      <h2 className="text-sm font-semibold text-white">Touchpoints</h2>
      <div className="mt-3 grid gap-2">
        {touchpoints.length ? touchpoints.map((touchpoint) => (
          <div key={touchpoint.id} className="rounded border border-port-border bg-port-bg p-3">
            <div className="flex items-center justify-between gap-3 text-xs text-gray-500">
              <span>{touchpoint.happenedAt?.slice(0, 10)}</span>
              <TouchpointSource source={touchpoint.source} />
            </div>
            <p className="mt-1 text-sm text-gray-300">{touchpoint.summary || touchpoint.channel || 'Touchpoint'}</p>
          </div>
        )) : (
          <p className="text-sm text-gray-500">No touchpoints logged yet.</p>
        )}
      </div>
    </section>
  );
}

function EmptyState({ onNew }) {
  return (
    <div className="flex min-h-[280px] flex-col items-center justify-center rounded border border-dashed border-port-border bg-port-card/60 p-8 text-center">
      <Users size={42} className="text-gray-600" aria-hidden="true" />
      <h2 className="mt-4 text-lg font-semibold text-white">No relationships yet</h2>
      <p className="mt-2 max-w-md text-sm text-gray-500">
        Add the first person in your circle, then PortOS can keep cadence, ring size, and care queue visible.
      </p>
      <button
        type="button"
        onClick={onNew}
        className="mt-5 inline-flex items-center gap-2 rounded bg-port-accent px-3 py-2 text-sm font-medium text-black hover:bg-port-accent/90"
      >
        <Plus size={15} aria-hidden="true" />
        Add Relationship
      </button>
    </div>
  );
}

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
function OutreachQueue() {
  // null = still loading; [] = loaded-empty. Distinguishing them keeps the panel
  // from flashing an empty state before the first fetch resolves.
  const [threads, setThreads] = useState(null);
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
    let cancelled = false;
    api.getTribeOutreach({ silent: true })
      .then((result) => { if (!cancelled) setThreads(result?.threads || []); })
      .catch(() => { if (!cancelled) setThreads([]); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!outreachKey || !Array.isArray(threads)) return;
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
    const result = await api.generateTribeOutreachDraft(seed, { silent: true }).catch((err) => {
      // The Care Queue loaded once, so the thread may have moved on (409):
      //  - ALREADY_REPLIED: you answered it → drop the now-resolved nudge.
      //  - STALE_INBOUND: they sent a newer message → it's STILL unanswered, so
      //    refetch to pick up the latest turn rather than falsely dropping it.
      if (err?.code === 'ALREADY_REPLIED') {
        setThreads((prev) => (prev || []).filter((t) => t.conversationKey !== key));
        toast.success(`Looks like you already replied to ${thread.personName}`);
      } else if (err?.code === 'STALE_INBOUND') {
        api.getTribeOutreach({ silent: true })
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

  // Quiet when loading or when nothing is unanswered — the Care Queue below still
  // shows cadence nudges, so an empty outreach panel would just be noise.
  if (threads === null || !threads.length) return null;

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

function CareQueue({ contacts, statusFilter, onStatusFilterChange, onSelect, onLogTouch, onNew }) {
  // External people are outside the tribe — no care cadence is owed, so they
  // never appear in the queue (otherwise their null daysRemaining would sort
  // them to the top alongside genuinely-overdue contacts). Memoized + status
  // computed once per contact (instead of twice per comparison in the sort).
  const queue = useMemo(() => contacts
    .filter((contact) => contact.ring !== 'external' && matchesStatusFilter(contact, statusFilter))
    .map((contact) => {
      const score = contactStatus(contact).daysRemaining;
      return { contact, score: score == null ? -999 : score };
    })
    .sort((a, b) => a.score - b.score)
    .map(({ contact }) => contact), [contacts, statusFilter]);

  // A filtered-to-empty queue is a success state ("nobody is overdue"), not the
  // "no relationships yet" onboarding empty — only show the latter when the whole
  // roster is empty.
  if (!queue.length && statusFilter === DEFAULT_STATUS) return <EmptyState onNew={onNew} />;

  return (
    <div className="grid gap-3">
      <StatusFilterBar statusFilter={statusFilter} onChange={onStatusFilterChange} />
      {queue.length ? queue.map((contact) => (
        <ContactCard
          key={contact.id}
          contact={contact}
          active={false}
          onSelect={() => onSelect(contact)}
          onLogTouch={() => onLogTouch(contact.id)}
        />
      )) : (
        <div className="rounded border border-port-border bg-port-card p-8 text-center text-sm text-gray-500">
          Nobody is in the {STATUS_FILTER_LABELS[statusFilter].toLowerCase()} bucket right now.
        </div>
      )}
    </div>
  );
}

// Care-state filter shared by the Care Queue and the Circle roster — the same
// buckets the summary tiles route into, so a tile click and this bar stay in sync.
function StatusFilterBar({ statusFilter, onChange }) {
  return (
    <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Care filter">
      {STATUS_FILTER_IDS.map((id) => (
        <button
          key={id}
          type="button"
          onClick={() => onChange(id)}
          aria-pressed={statusFilter === id}
          className={`rounded-full border px-3 py-1 text-xs transition-colors ${
            statusFilter === id
              ? 'border-port-accent/70 bg-port-accent/10 text-port-accent'
              : 'border-port-border text-gray-400 hover:text-white'
          }`}
        >
          {STATUS_FILTER_LABELS[id]}
        </button>
      ))}
    </div>
  );
}

function FocusPanel({ contacts }) {
  const byEnergy = useMemo(() => ENERGY.map((energy) => ({
    ...energy,
    count: contacts.filter((contact) => contact.energy === energy.id).length,
  })), [contacts]);
  const support = useMemo(() => contacts.filter((contact) => contact.ring === 'support'), [contacts]);
  const nextMoves = useMemo(() => contacts.filter((contact) => contact.nextMove).slice(0, 8), [contacts]);

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(280px,360px)]">
      <section className="border border-port-border bg-port-card rounded p-4">
        <div className="flex items-center gap-2">
          <Heart size={18} className="text-port-accent" aria-hidden="true" />
          <h2 className="text-sm font-semibold text-white">Inner Circle</h2>
        </div>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          {support.length ? support.map((contact) => (
            <div key={contact.id} className="rounded border border-port-border bg-port-bg p-3">
              <p className="font-medium text-white">{contact.name}</p>
              <p className="mt-1 text-sm text-gray-500">{contact.relationship || 'Support'}</p>
              {contact.nextMove && <p className="mt-3 text-sm text-gray-300">{contact.nextMove}</p>}
            </div>
          )) : (
            <p className="text-sm text-gray-500 sm:col-span-2">No support-ring relationships yet.</p>
          )}
        </div>
      </section>

      <aside className="grid gap-4">
        <div className="border border-port-border bg-port-card rounded p-4">
          <h2 className="text-sm font-semibold text-white">Energy Mix</h2>
          <div className="mt-4 grid gap-2">
            {byEnergy.map((energy) => (
              <div key={energy.id} className="flex items-center justify-between gap-3">
                <span className={`rounded border px-2 py-1 text-xs ${energy.className}`}>{energy.label}</span>
                <span className="text-sm text-gray-300">{energy.count}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="border border-port-border bg-port-card rounded p-4">
          <h2 className="text-sm font-semibold text-white">Next Moves</h2>
          <div className="mt-4 grid gap-3">
            {nextMoves.length ? nextMoves.map((contact) => (
              <div key={contact.id} className="border-l border-port-accent/40 pl-3">
                <p className="text-sm font-medium text-white">{contact.name}</p>
                <p className="text-sm text-gray-400">{contact.nextMove}</p>
              </div>
            )) : (
              <p className="text-sm text-gray-500">No next moves captured.</p>
            )}
          </div>
        </div>
      </aside>
    </div>
  );
}

export default function Tribe() {
  const [contacts, setContacts] = useState([]);
  const [draft, setDraft] = useState(emptyDraft);
  const [query, setQuery] = useState('');
  const [ringFilter, setRingFilter] = useState('all');
  // Active tab lives in the URL (`?tab=`) so a section is shareable, bookmarkable,
  // and reload-safe. Unknown/stale values fall back to the default tab. The
  // default is omitted from the URL to keep `/tribe` clean.
  const [searchParams, setSearchParams] = useSearchParams();
  const rawTab = searchParams.get('tab');
  const activeTab = TAB_IDS.includes(rawTab) ? rawTab : DEFAULT_TAB;
  // Resolve inside the setSearchParams updater so functional updates (e.g.
  // startNewRelationship) read the FRESHEST tab from the URL, not the value
  // captured when a since-superseded async closure was created — otherwise a
  // create-in-flight + tab switch could clobber the user's current tab.
  const setActiveTab = (next) => {
    setSearchParams((prev) => {
      const prevRaw = prev.get('tab');
      const prevTab = TAB_IDS.includes(prevRaw) ? prevRaw : DEFAULT_TAB;
      const resolved = typeof next === 'function' ? next(prevTab) : next;
      return withParam(new URLSearchParams(prev), 'tab', resolved, DEFAULT_TAB);
    }, { replace: true });
  };
  // The care-state filter lives in the URL too (`?status=overdue`), so "show me
  // the 17 overdue people" is shareable and survives a reload.
  const rawStatus = searchParams.get('status');
  const statusFilter = STATUS_FILTER_IDS.includes(rawStatus) ? rawStatus : DEFAULT_STATUS;
  const setStatusFilter = (next) => {
    setSearchParams((prev) => withParam(new URLSearchParams(prev), 'status', next, DEFAULT_STATUS), { replace: true });
  };
  // Jump from a summary tile straight into the queue it describes; clicking the
  // active tile again clears back to everyone.
  const focusStatus = (next) => {
    const resolved = statusFilter === next ? DEFAULT_STATUS : next;
    setSearchParams((prev) => {
      const params = withParam(new URLSearchParams(prev), 'status', resolved, DEFAULT_STATUS);
      return resolved === DEFAULT_STATUS ? params : withParam(params, 'tab', 'care', DEFAULT_TAB);
    }, { replace: true });
  };
  const [ringsOpen, setRingsOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  // Bumped by every "Add / new relationship" trigger so the form can be
  // surfaced (scrolled into view + Name focused). The form is statically
  // rendered, so resetting an already-empty draft is otherwise invisible —
  // especially on narrow screens where it sits below the fold.
  const [focusTick, setFocusTick] = useState(0);
  const nameInputRef = useRef(null);
  const formRef = useRef(null);
  // The form only mounts when `!loading`. An Add can fire while a reload is in
  // flight (e.g. the post-save `tribe:changed` broadcast sets loading=true), so
  // record a pending request and let the effect retry once the form mounts
  // instead of consuming the tick against an unmounted form.
  const pendingFocusRef = useRef(false);
  // Non-blocking duplicate-identifier report (#5908) — `null` until the first
  // fetch resolves, so "nothing yet" never briefly renders as "confirmed clean".
  const [duplicates, setDuplicates] = useState(null);
  const [duplicatesDismissed, setDuplicatesDismissed] = useState(false);

  const selectedId = draft.id;

  const loadContacts = async (isCancelled = () => false) => {
    setLoading(true);
    const result = await api.getTribePeople({ silent: true }).catch((err) => {
      if (!isCancelled()) toast.error(err.message || 'Failed to load Tribe');
      // null (not an empty list) so a failed fetch is distinguishable from a
      // genuinely-empty server — otherwise a transient error would trigger the
      // one-shot legacy localStorage import and duplicate data on recovery.
      return null;
    });
    if (isCancelled()) return;
    const fetchFailed = result === null;
    let people = result?.people || [];

    const legacy = getLegacyContacts();
    if (!fetchFailed && people.length === 0 && legacy.length > 0) {
      const imported = [];
      for (const contact of legacy) {
        const created = await api.createTribePerson({
          name: contact.name || 'Unnamed person',
          relationship: contact.relationship || '',
          ring: contact.ring || 'tribe',
          cadenceDays: Math.max(1, Number(contact.cadenceDays) || ringFor(contact.ring).cadenceDays),
          lastContact: contact.lastContact || null,
          channel: contact.channel || '',
          energy: contact.energy || 'steady',
          tags: tagsToArray(contact.tags),
          nextMove: contact.nextMove || '',
          notes: contact.notes || '',
        }).catch(() => null);
        if (created) imported.push(created);
      }
      if (imported.length > 0) {
        people = imported;
        clearLegacyContacts();
        toast.success(`Imported ${imported.length} Tribe relationship${imported.length === 1 ? '' : 's'} into Postgres`);
      }
    }

    if (isCancelled()) return;
    setContacts(people);
    setLoading(false);
  };

  useEffect(() => {
    let cancelled = false;
    const isCancelled = () => cancelled;
    loadContacts(isCancelled);
    const loadDuplicates = () => api.getTribeDuplicateIdentifiers({ silent: true })
      .then((report) => { if (!isCancelled()) setDuplicates(report); })
      .catch(() => { if (!isCancelled()) setDuplicates({ emails: [], phones: [] }); });
    loadDuplicates();
    // Mutations broadcast `tribe:changed` from the server; reconcile against
    // server truth (covers other tabs/devices and the GREATEST last-contact
    // merge that optimistic updates can't predict).
    const handleChanged = () => { loadContacts(isCancelled); loadDuplicates(); };
    socket.on('tribe:changed', handleChanged);
    return () => {
      cancelled = true;
      socket.off('tribe:changed', handleChanged);
    };
  }, []);

  // Surface the contact form after an Add trigger. The form only exists once
  // loading is done and a form-bearing tab is active, so this also re-runs on
  // `loading`/`activeTab` and waits (keeping the pending flag set) until the
  // form actually mounts — otherwise a tick that fires mid-reload is lost.
  useEffect(() => {
    if (!pendingFocusRef.current || loading) return;
    const frame = requestAnimationFrame(() => {
      if (!formRef.current) return; // still unmounted — retry on next dep change
      formRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' });
      nameInputRef.current?.focus();
      pendingFocusRef.current = false;
    });
    return () => cancelAnimationFrame(frame);
  }, [focusTick, loading, activeTab]);

  // Reset to a blank draft and surface the form. The Focus and Map tabs have no
  // form, so fall back to Circle there; otherwise keep the user's current tab.
  const startNewRelationship = () => {
    setActiveTab((tab) => (tab === 'focus' || tab === 'map' ? 'circle' : tab));
    setDraft(emptyDraft());
    pendingFocusRef.current = true;
    setFocusTick((tick) => tick + 1);
  };

  const filteredContacts = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return contacts.filter((contact) => {
      if (ringFilter !== 'all' && contact.ring !== ringFilter) return false;
      if (!matchesStatusFilter(contact, statusFilter)) return false;
      if (!normalized) return true;
      const haystack = [
        contact.name,
        contact.relationship,
        contact.channel,
        tagsToArray(contact.tags).join(' '),
        contact.nextMove,
        contact.notes,
      ].join(' ').toLowerCase();
      return haystack.includes(normalized);
    });
  }, [contacts, query, ringFilter, statusFilter]);

  // overdue/soon already exclude external (its status state is 'external', not in
  // these lists). Capacity is the Dunbar tribe horizon, so it excludes external too.
  const overdueCount = contacts.filter((contact) => ['missing', 'overdue'].includes(contactStatus(contact).state)).length;
  const soonCount = contacts.filter((contact) => contactStatus(contact).state === 'soon').length;
  const supportCount = contacts.filter((contact) => contact.ring === 'support').length;
  const tribeCount = contacts.filter((contact) => contact.ring !== 'external').length;
  const externalCount = contacts.length - tribeCount;

  const selectContact = (contact) => setDraft({
    ...emptyDraft(),
    ...contact,
    tags: tagsToInput(contact.tags),
    emails: tagsToInput(contact.emails),
    phones: tagsToInput(contact.phones),
    cadenceDays: contact.cadenceDays || ringFor(contact.ring).cadenceDays,
  });

  const saveDraft = async () => {
    // Send only the editable fields the schema accepts. The PUT route rejects a
    // body `id` (`z.never()`) — it comes from the URL — and `lastContact` must be
    // null (not '') when empty, so a bare `{ ...draft }` would 400 on both counts.
    const payload = {
      name: draft.name.trim() || 'Unnamed person',
      relationship: draft.relationship.trim(),
      ring: draft.ring,
      cadenceDays: Math.max(1, Number(draft.cadenceDays) || ringFor(draft.ring).cadenceDays),
      lastContact: draft.lastContact || null,
      channel: draft.channel.trim(),
      energy: draft.energy,
      tags: tagsToArray(draft.tags),
      emails: tagsToArray(draft.emails),
      phones: tagsToArray(draft.phones),
      nextMove: draft.nextMove.trim(),
      notes: draft.notes.trim(),
    };

    const isCreate = !draft.id;
    setSaving(true);
    const saved = draft.id
      ? await api.updateTribePerson(draft.id, payload, { silent: true }).catch((err) => {
          toast.error(err.message || 'Failed to save relationship');
          return null;
        })
      : await api.createTribePerson(payload, { silent: true }).catch((err) => {
          toast.error(err.message || 'Failed to save relationship');
          return null;
        });
    setSaving(false);
    if (!saved) return;

    setContacts((current) => (
      current.some((contact) => contact.id === saved.id)
        ? current.map((contact) => (contact.id === saved.id ? saved : contact))
        : [saved, ...current]
    ));
    // After creating a NEW person, clear back to a blank form (and re-focus Name)
    // so the next entry adds another person instead of overwriting the one just
    // saved. When editing an existing person, keep them selected.
    if (isCreate) {
      startNewRelationship();
    } else {
      selectContact(saved);
    }
  };

  const deleteDraft = async () => {
    if (!draft.id) return;
    const result = await api.deleteTribePerson(draft.id, { silent: true }).catch((err) => {
      toast.error(err.message || 'Failed to delete relationship');
      return null;
    });
    if (!result?.success) return;
    setContacts((current) => current.filter((contact) => contact.id !== draft.id));
    setDraft(emptyDraft());
  };

  const logTouch = async (id) => {
    const now = new Date();
    const date = localDateStr(now);
    const result = await api.createTribeTouchpoint(id, {
      happenedAt: now.toISOString(),
      localDate: date,
      channel: contacts.find((contact) => contact.id === id)?.channel || '',
      summary: 'Manual touchpoint',
      source: 'user',
    }, { silent: true }).catch((err) => {
      toast.error(err.message || 'Failed to log touchpoint');
      return null;
    });
    if (!result?.id) return;
    setContacts((current) => current.map((contact) => (
      contact.id === id ? { ...contact, lastContact: date } : contact
    )));
    if (draft.id === id) setDraft((current) => ({ ...current, lastContact: date }));
  };

  const clearFilters = () => {
    setQuery('');
    setRingFilter('all');
    setStatusFilter(DEFAULT_STATUS);
  };

  const duplicateGroups = [...(duplicates?.emails || []), ...(duplicates?.phones || [])];

  const actions = (
    <button
      type="button"
      onClick={startNewRelationship}
      className="inline-flex items-center gap-2 rounded border border-port-border px-3 py-2 text-sm text-gray-300 hover:bg-port-border/40 hover:text-white"
    >
      <Plus size={15} aria-hidden="true" />
      Add
    </button>
  );

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        icon={Users}
        title="Tribe"
        subtitle="Relationships, rings, cadence, and care."
        actions={actions}
      />

      <TabPills tabs={TABS} activeTab={activeTab} onChange={setActiveTab} ariaLabel="Tribe sections" />

      <main className="flex-1 overflow-auto p-4">
        <div className="mx-auto grid max-w-7xl gap-4">
          {loading && (
            <div className="flex min-h-[220px] items-center justify-center">
              <BrailleSpinner text="Loading Tribe" />
            </div>
          )}
          {!loading && (
            <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatTile icon={Users} label="Relationships" value={contacts.length} detail={externalCount ? `${supportCount} support · ${externalCount} external` : `${supportCount} support ring`} />
            <StatTile
              icon={Clock}
              label="Needs Care"
              value={overdueCount}
              detail="missing or overdue"
              onClick={() => focusStatus('overdue')}
              active={statusFilter === 'overdue'}
            />
            <StatTile
              icon={Calendar}
              label="Coming Up"
              value={soonCount}
              detail="due within 7 days"
              onClick={() => focusStatus('soon')}
              active={statusFilter === 'soon'}
            />
            <StatTile icon={Heart} label="Capacity" value={`${tribeCount}/150`} detail="village horizon" />
          </div>

          {duplicateGroups.length > 0 && !duplicatesDismissed && (
            <Banner
              tone="warning"
              icon={AlertTriangle}
              title="Shared contact info"
              actions={(
                <button
                  type="button"
                  onClick={() => setDuplicatesDismissed(true)}
                  aria-label="Dismiss shared contact info notice"
                  className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center rounded text-port-warning/70 hover:text-port-warning"
                >
                  <X size={14} aria-hidden="true" />
                </button>
              )}
            >
              {/* Non-blocking report (#5908): the same email/phone is on file for more
                  than one person, so a routine sync can silently re-target every later
                  touchpoint from one to the other. Naming it is the whole feature — this
                  never merges or edits anyone automatically. */}
              {duplicateGroups.map((group) => (
                <div key={group.identifier}>
                  <span className="font-mono">{group.identifier}</span> is on file for{' '}
                  {group.people.map((p) => p.name).join(' and ')}.
                </div>
              ))}
            </Banner>
          )}

          {activeTab === 'circle' && (
            <div className="grid gap-4 xl:grid-cols-[310px_minmax(0,1fr)_minmax(330px,420px)]">
              {/* Five ring meters are a dashboard, not the task — below xl they
                  collapse behind a disclosure so the search field and the first
                  people stay on the first screen (#3791). */}
              <aside className="grid content-start gap-3">
                <button
                  type="button"
                  onClick={() => setRingsOpen((open) => !open)}
                  aria-expanded={ringsOpen}
                  className="flex items-center justify-between gap-2 rounded border border-port-border bg-port-card px-3 py-2 text-sm text-gray-300 hover:text-white xl:hidden"
                >
                  <span>Ring capacity</span>
                  <span className="text-xs text-gray-500">{ringsOpen ? 'Hide' : 'Show'}</span>
                </button>
                <div className={`content-start gap-3 xl:grid ${ringsOpen ? 'grid' : 'hidden'}`}>
                  {RINGS.map((ring) => (
                    <RingMeter
                      key={ring.id}
                      ring={ring}
                      contacts={contacts}
                      active={ringFilter === ring.id}
                      onClick={() => setRingFilter(ringFilter === ring.id ? 'all' : ring.id)}
                    />
                  ))}
                </div>
              </aside>

              <section className="min-w-0">
                <div className="mb-3 flex flex-col gap-2 sm:flex-row">
                  <label className="relative min-w-0 flex-1">
                    <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-gray-500" aria-hidden="true" />
                    <input
                      aria-label="Search relationships"
                      value={query}
                      onChange={(event) => setQuery(event.target.value)}
                      className="w-full rounded border border-port-border bg-port-card py-2 pl-9 pr-3 text-sm text-white outline-none focus:border-port-accent"
                      placeholder="Search relationships"
                    />
                  </label>
                  <label className="relative sm:w-44">
                    <Filter size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-gray-500" aria-hidden="true" />
                    <select
                      aria-label="Filter relationships by ring"
                      value={ringFilter}
                      onChange={(event) => setRingFilter(event.target.value)}
                      className="w-full rounded border border-port-border bg-port-card py-2 pl-9 pr-3 text-sm text-white outline-none focus:border-port-accent"
                    >
                      <option value="all">All rings</option>
                      {RINGS.map((ring) => <option key={ring.id} value={ring.id}>{ring.label}</option>)}
                    </select>
                  </label>
                  {(query || ringFilter !== 'all' || statusFilter !== DEFAULT_STATUS) && (
                    <button
                      type="button"
                      onClick={clearFilters}
                      title="Clear filters"
                      aria-label="Clear filters"
                      className="inline-flex h-10 w-10 items-center justify-center rounded border border-port-border text-gray-400 hover:bg-port-border/40 hover:text-white"
                    >
                      <X size={16} aria-hidden="true" />
                    </button>
                  )}
                </div>

                <div className="mb-3">
                  <StatusFilterBar statusFilter={statusFilter} onChange={setStatusFilter} />
                </div>

                {contacts.length === 0 ? (
                  <EmptyState onNew={startNewRelationship} />
                ) : (
                  <div className="grid gap-3 md:grid-cols-2">
                    {filteredContacts.map((contact) => (
                      <ContactCard
                        key={contact.id}
                        contact={contact}
                        active={selectedId === contact.id}
                        onSelect={() => selectContact(contact)}
                        onLogTouch={() => logTouch(contact.id)}
                      />
                    ))}
                    {filteredContacts.length === 0 && (
                      <div className="rounded border border-port-border bg-port-card p-8 text-center text-sm text-gray-500 md:col-span-2">
                        No relationships match the current filters.
                      </div>
                    )}
                  </div>
                )}
              </section>

              <aside className="min-w-0">
                <ContactForm
                  draft={draft}
                  onChange={setDraft}
                  onSave={saveDraft}
                  onDelete={deleteDraft}
                  onNew={startNewRelationship}
                  isExisting={Boolean(draft.id)}
                  saving={saving}
                  nameInputRef={nameInputRef}
                  formRef={formRef}
                />
                {draft.id && <MemoryLinksPanel personId={draft.id} />}
                {draft.id && <TouchpointsPanel personId={draft.id} />}
              </aside>
            </div>
          )}

          {activeTab === 'map' && (
            contacts.length === 0 ? (
              <EmptyState onNew={startNewRelationship} />
            ) : (
              <TribeCircleMap
                contacts={contacts}
                selectedId={selectedId}
                onSelect={(contact) => { selectContact(contact); setActiveTab('circle'); }}
                onLogTouch={logTouch}
              />
            )
          )}

          {activeTab === 'care' && (
            <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(330px,420px)]">
              <div className="grid gap-4">
                <OutreachQueue />
                <CareQueue
                  contacts={contacts}
                  statusFilter={statusFilter}
                  onStatusFilterChange={setStatusFilter}
                  onSelect={(contact) => { selectContact(contact); setActiveTab('circle'); }}
                  onLogTouch={logTouch}
                  onNew={startNewRelationship}
                />
              </div>
              <ContactForm
                draft={draft}
                onChange={setDraft}
                onSave={saveDraft}
                onDelete={deleteDraft}
                onNew={startNewRelationship}
                isExisting={Boolean(draft.id)}
                saving={saving}
                nameInputRef={nameInputRef}
                formRef={formRef}
              />
            </div>
          )}

          {activeTab === 'focus' && <FocusPanel contacts={contacts} />}
            </>
          )}
        </div>
      </main>
    </div>
  );
}
