/**
 * SongBook cross-links to the other music record kinds in PortOS (#4103) —
 * Rounds (`/rounds/:id`) and music Tracks (`/music/tracks/:id`).
 *
 * Two surfaces over the same `links: [{ type, id, label }]` array stored on the
 * song record (schema: `songLinkSchema` in server/lib/brainValidation.js):
 *
 * - <SongLinkChips>  — play mode. Read-only chips that navigate to the target.
 * - <SongLinksEditor> — edit mode. Type select + record select + Add, over the
 *   draft array; removal is inline per row.
 *
 * `label` is denormalized at link time on purpose: Rounds and Tracks are NOT
 * brain records and do not necessarily exist on every federated machine, so a
 * link whose target is missing here still renders a name rather than a bare id.
 * The editor prefers the FRESH title when the target is present locally (a
 * renamed round shouldn't read stale), and falls back to the stored label.
 */

import { useState, useEffect, useMemo } from 'react';
import { Link } from 'react-router';
import { Link2, Plus, X } from 'lucide-react';
import { listRounds, listTracks } from '../../services/api';
import {
  SONG_LINK_TYPES, songLinkHref, songLinkKey, songLinkTypeLabel, inputClass, labelClass,
} from './constants';

// What a chip/row shows: the target's current title when we can see it, else the
// label captured when the link was made, else the raw id (never blank).
const linkText = (link, freshTitle) => freshTitle || link.label || link.id;

export function SongLinkChips({ links, className = '' }) {
  if (!links?.length) return null;
  return (
    <div className={`flex flex-wrap items-center gap-2 text-xs ${className}`}>
      {links.map((link) => {
        const href = songLinkHref(link);
        const text = linkText(link);
        const inner = (
          <>
            <Link2 size={12} className="shrink-0" />
            <span className="text-gray-500">{songLinkTypeLabel(link.type)}</span>
            <span className="truncate max-w-[14rem]">{text}</span>
          </>
        );
        // An unknown link type has no route to send the user to (a song synced
        // from a newer peer) — render it as a plain chip rather than a dead link.
        return href ? (
          <Link
            key={songLinkKey(link)}
            to={href}
            className="flex items-center gap-1 px-2 py-1 rounded-full bg-port-bg border border-port-border text-port-accent hover:border-port-accent/50"
          >
            {inner}
          </Link>
        ) : (
          <span
            key={songLinkKey(link)}
            className="flex items-center gap-1 px-2 py-1 rounded-full bg-port-bg border border-port-border text-gray-400"
          >
            {inner}
          </span>
        );
      })}
    </div>
  );
}

export function SongLinksEditor({ links, onChange }) {
  // null = not fetched yet (or the fetch failed) vs [] = fetched and this
  // install genuinely has no records of that kind — the two must not collapse,
  // or an empty install reads as "still loading" forever.
  const [rounds, setRounds] = useState(null);
  const [tracks, setTracks] = useState(null);
  const [type, setType] = useState(SONG_LINK_TYPES[0].id);
  const [targetId, setTargetId] = useState('');

  // Both lists load once when the editor mounts. `.catch` swallows the failure
  // on purpose — a rounds/tracks outage must not block editing the SONG, and
  // request() already toasted, so `{ silent: true }` keeps it to one toast.
  useEffect(() => {
    let alive = true;
    listRounds({ silent: true })
      .then((res) => { if (alive) setRounds(Array.isArray(res?.rounds) ? res.rounds : []); })
      .catch(() => { if (alive) setRounds([]); });
    listTracks({ silent: true })
      .then((res) => { if (alive) setTracks(Array.isArray(res) ? res : []); })
      .catch(() => { if (alive) setTracks([]); });
    return () => { alive = false; };
  }, []);

  const recordsByType = useMemo(() => ({ round: rounds, track: tracks }), [rounds, tracks]);

  // Options for the currently selected type, minus anything already linked.
  const linked = useMemo(() => new Set(links.map(songLinkKey)), [links]);
  const options = useMemo(() => (
    (recordsByType[type] || [])
      .filter((r) => r?.id && !linked.has(`${type}:${r.id}`))
      .map((r) => ({ id: r.id, title: r.title || r.id }))
  ), [recordsByType, type, linked]);

  // Titles for rows whose target IS present locally, so a renamed record shows
  // its current name instead of the label frozen at link time.
  const freshTitles = useMemo(() => {
    const map = new Map();
    for (const [kind, records] of Object.entries(recordsByType)) {
      for (const r of records || []) {
        if (r?.id && r.title) map.set(`${kind}:${r.id}`, r.title);
      }
    }
    return map;
  }, [recordsByType]);

  const add = () => {
    if (!targetId) return;
    const label = options.find((o) => o.id === targetId)?.title || '';
    onChange([...links, { type, id: targetId, label }]);
    setTargetId('');
  };

  const remove = (link) => onChange(links.filter((l) => songLinkKey(l) !== songLinkKey(link)));

  const loading = recordsByType[type] === null;

  return (
    <div>
      <span className={labelClass}>Linked records</span>

      {links.length > 0 && (
        <ul className="space-y-1 mb-2">
          {links.map((link) => (
            <li
              key={songLinkKey(link)}
              className="flex items-center gap-2 px-3 py-2 bg-port-card border border-port-border rounded-lg text-sm"
            >
              <span className="shrink-0 text-xs text-gray-500">{songLinkTypeLabel(link.type)}</span>
              <span className="flex-1 min-w-0 truncate text-gray-200">
                {linkText(link, freshTitles.get(songLinkKey(link)))}
              </span>
              <button
                type="button"
                onClick={() => remove(link)}
                className="p-1 shrink-0 text-gray-500 hover:text-port-error"
                aria-label={`Remove link to ${linkText(link, freshTitles.get(songLinkKey(link)))}`}
              >
                <X size={14} />
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-col sm:flex-row gap-2">
        <div className="sm:w-32">
          <label htmlFor="song-link-type" className="sr-only">Link type</label>
          <select
            id="song-link-type"
            value={type}
            onChange={(e) => { setType(e.target.value); setTargetId(''); }}
            className={inputClass}
          >
            {SONG_LINK_TYPES.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
          </select>
        </div>
        <div className="flex-1 min-w-0">
          <label htmlFor="song-link-target" className="sr-only">Record to link</label>
          <select
            id="song-link-target"
            value={targetId}
            onChange={(e) => setTargetId(e.target.value)}
            disabled={loading || options.length === 0}
            className={inputClass}
          >
            <option value="">
              {loading ? 'Loading…' : options.length === 0 ? `No ${songLinkTypeLabel(type).toLowerCase()}s available` : 'Select…'}
            </option>
            {options.map((o) => <option key={o.id} value={o.id}>{o.title}</option>)}
          </select>
        </div>
        <button
          type="button"
          onClick={add}
          disabled={!targetId}
          className="flex items-center justify-center gap-1.5 px-3 py-2 text-sm rounded-lg border border-port-border text-gray-300 hover:text-white hover:bg-port-border/50 disabled:opacity-50"
        >
          <Plus size={14} />
          Add link
        </button>
      </div>
    </div>
  );
}
