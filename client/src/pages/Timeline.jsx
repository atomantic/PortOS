import { useState, useEffect, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  CalendarClock, ChevronLeft, ChevronRight, Mail, MailOpen, Send,
  CalendarDays, Music, Play, MessageSquare, Activity, MapPin, Globe,
} from 'lucide-react';
import PageHeader from '../components/PageHeader';
import SpotifyImportPanel from '../components/timeline/SpotifyImportPanel';
import TakeoutLocationImportPanel from '../components/timeline/TakeoutLocationImportPanel';
import DiscordImportPanel from '../components/timeline/DiscordImportPanel';
import WhatsappImportPanel from '../components/timeline/WhatsappImportPanel';
import BrowserHistoryImportPanel from '../components/timeline/BrowserHistoryImportPanel';
import YoutubeImportPanel from '../components/timeline/YoutubeImportPanel';
import * as api from '../services/api';
import toast from '../components/ui/Toast';
import { formatClockTime, formatDurationSec } from '../utils/formatters';

// Local (browser-tz) YYYY-MM-DD for a Date — matches the server's local-day math
// closely enough for defaulting the URL; the server is the source of truth for
// which UTC instants fall in the day it returns.
function localDateStr(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function shiftDate(dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + days);
  return localDateStr(dt);
}

const SOURCE_ICON = {
  gmail: Mail,
  outlook: Mail,
  teams: MessageSquare,
  imap: Mail,
  calendar: CalendarDays,
  imessage: MessageSquare,
  signal: MessageSquare,
  spotify: Music,
  youtube: Play,
  location: MapPin,
  discord: MessageSquare,
  browser: Globe,
};

function kindIcon(kind, source) {
  if (kind === 'message.sent') return Send;
  if (kind === 'message.received') return MailOpen;
  if (kind === 'calendar.event') return CalendarDays;
  if (kind === 'place.visit') return MapPin;
  if (kind === 'web.visit') return Globe;
  return SOURCE_ICON[source] || Activity;
}

function KindBadge({ kind }) {
  const label = kind === 'message.sent' ? 'Sent'
    : kind === 'message.received' ? 'Received'
      : kind === 'calendar.event' ? 'Event'
        : kind === 'place.visit' ? 'Visit'
          : kind === 'web.visit' ? 'Web'
            : kind;
  return (
    <span className="rounded bg-port-bg px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-gray-400">
      {label}
    </span>
  );
}

function Histogram({ histogram }) {
  const max = useMemo(() => Math.max(1, ...histogram.map((h) => h.count)), [histogram]);
  return (
    <div className="rounded border border-port-border bg-port-card p-3">
      <div className="mb-2 text-xs font-medium text-gray-400">Activity by hour</div>
      <div className="flex items-end gap-[2px]" style={{ height: 64 }} role="img" aria-label="Hourly activity histogram">
        {histogram.map((h) => (
          <div key={h.hour} className="flex flex-1 flex-col items-center justify-end" title={`${h.hour}:00 — ${h.count} event(s)`}>
            <div
              className={`w-full rounded-t ${h.count ? 'bg-port-accent' : 'bg-port-border'}`}
              style={{ height: `${Math.max(2, (h.count / max) * 56)}px` }}
            />
          </div>
        ))}
      </div>
      <div className="mt-1 flex justify-between text-[10px] text-gray-500">
        <span>12a</span><span>6a</span><span>12p</span><span>6p</span><span>11p</span>
      </div>
    </div>
  );
}

// `timezone` is the server's configured user timezone — event times render in
// it so rows line up with the day window and histogram buckets even when the
// browser is in a different zone (e.g. viewing remotely over Tailscale).
function EventRow({ event, timezone }) {
  const Icon = kindIcon(event.kind, event.source);
  const when = new Date(event.happenedAt);
  const participants = (event.participants || [])
    .map((p) => p.name || p.email || p.phone)
    .filter(Boolean)
    .slice(0, 4)
    .join(', ');
  return (
    <div className="flex gap-3 rounded border border-port-border bg-port-card p-3 min-w-0">
      <div className="flex flex-col items-center pt-0.5">
        <Icon size={16} className="text-port-accent" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-xs text-gray-500">{formatClockTime(when, { timeZone: timezone })}</span>
          <KindBadge kind={event.kind} />
          <span className="text-[10px] uppercase tracking-wide text-gray-500">{event.source}</span>
          {Number.isFinite(event.durationS) && event.durationS > 0 && (
            <span className="text-[10px] text-gray-500">{formatDurationSec(event.durationS)}</span>
          )}
        </div>
        <div className="mt-1 truncate font-medium text-gray-100">{event.title || '(untitled)'}</div>
        {event.summary && <div className="mt-0.5 truncate text-sm text-gray-400">{event.summary}</div>}
        {participants && <div className="mt-0.5 truncate text-xs text-gray-500">{participants}</div>}
      </div>
    </div>
  );
}

export default function Timeline() {
  const { date: dateParam } = useParams();
  const navigate = useNavigate();
  // Bare /timeline sends NO date — the server defaults to "today" in the USER's
  // configured timezone (which may differ from this browser's). The response
  // carries both the resolved `date` and the server's `today`, so the display
  // and the Today/next-day gates follow the server's day, not the browser's.
  const urlDate = /^\d{4}-\d{2}-\d{2}$/.test(dateParam || '') ? dateParam : null;

  const [day, setDay] = useState(null);
  const [loading, setLoading] = useState(true);
  // Bumped after a bulk import lands so the current day view re-fetches.
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let active = true;
    setLoading(true);
    api.getTimelineDay(urlDate ? { date: urlDate, silent: true } : { silent: true })
      .then((result) => { if (active) setDay(result); })
      .catch((err) => { if (active) { setDay(null); toast.error(`Failed to load timeline: ${err.message}`); } })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [urlDate, reloadKey]);

  // Browser-local fallbacks cover only the loading/error window before the
  // server response supplies the authoritative `date` and `today`.
  const today = day?.today || localDateStr(new Date());
  const date = day?.date || urlDate || today;

  const goto = (target) => navigate(target === today ? '/timeline' : `/timeline/${target}`);

  const events = day?.events || [];
  const counts = day?.counts || { total: 0, bySource: {}, byKind: {} };
  const histogram = day?.histogram || Array.from({ length: 24 }, (_, hour) => ({ hour, count: 0 }));

  const dayLabel = useMemo(() => {
    const [y, m, d] = date.split('-').map(Number);
    return new Date(y, m - 1, d).toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric', year: 'numeric' });
  }, [date]);

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-4">
      <PageHeader
        icon={CalendarClock}
        title="Timeline"
        subtitle="Your unified activity across messages, calendar, and more."
      />

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => goto(shiftDate(date, -1))}
            className="rounded border border-port-border bg-port-card p-2 hover:border-port-accent"
            aria-label="Previous day"
          >
            <ChevronLeft size={16} />
          </button>
          <input
            type="date"
            value={date}
            max={today}
            onChange={(e) => e.target.value && goto(e.target.value)}
            className="rounded border border-port-border bg-port-card px-2 py-1.5 text-sm text-gray-100"
            aria-label="Select day"
          />
          <button
            type="button"
            onClick={() => goto(shiftDate(date, 1))}
            disabled={date >= today}
            className="rounded border border-port-border bg-port-card p-2 hover:border-port-accent disabled:cursor-not-allowed disabled:opacity-40"
            aria-label="Next day"
          >
            <ChevronRight size={16} />
          </button>
          {date !== today && (
            <button
              type="button"
              onClick={() => goto(today)}
              className="rounded border border-port-border bg-port-card px-3 py-1.5 text-sm hover:border-port-accent"
            >
              Today
            </button>
          )}
        </div>
        <div className="text-sm text-gray-400">{dayLabel}</div>
      </div>

      <SpotifyImportPanel onImported={() => setReloadKey((k) => k + 1)} />
      <TakeoutLocationImportPanel onImported={() => setReloadKey((k) => k + 1)} />
      <DiscordImportPanel onImported={() => setReloadKey((k) => k + 1)} />
      <WhatsappImportPanel onImported={() => setReloadKey((k) => k + 1)} />
      <BrowserHistoryImportPanel onImported={() => setReloadKey((k) => k + 1)} />
      <YoutubeImportPanel onImported={() => setReloadKey((k) => k + 1)} />

      <Histogram histogram={histogram} />

      <div className="flex flex-wrap gap-2 text-xs text-gray-400">
        <span className="rounded bg-port-card px-2 py-1 border border-port-border">{counts.total} events</span>
        {Object.entries(counts.bySource).map(([source, n]) => (
          <span key={source} className="rounded bg-port-card px-2 py-1 border border-port-border">
            {source}: {n}
          </span>
        ))}
      </div>

      {loading ? (
        <div className="py-12 text-center text-gray-500">Loading…</div>
      ) : events.length === 0 ? (
        <div className="rounded border border-dashed border-port-border py-12 text-center text-gray-500">
          No recorded activity on this day.
          <div className="mt-1 text-xs">Activity populates as your message and calendar accounts sync.</div>
        </div>
      ) : (
        <div className="flex flex-col gap-2 pb-6">
          {events.map((event) => <EventRow key={event.id} event={event} timezone={day?.timezone} />)}
        </div>
      )}
    </div>
  );
}
