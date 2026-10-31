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

import { useState, useMemo } from 'react';
import { Link } from 'react-router';
import { Link2, Plus, X } from 'lucide-react';
import { listRounds, listTracks } from '../../services/api';
import ListLoadError from '../ui/ListLoadError';
import useListResource from '../../hooks/useListResource';
import {
  SONG_LINK_TYPES, songLinkHref, songLinkKey, songLinkTypeLabel, inputClass, labelClass,
} from './constants';

// The editor owns the error UI, so the requests are silent.
const fetchRounds = () => listRounds({ silent: true }).then((res) => res?.rounds);
const fetchTracks = () => listTracks({ silent: true });

// What a chip/row shows: the target's current title when we can see it, else the
// label captured when the link was made, else the raw id (never blank).
const linkText = (link, freshTitle) => freshTitle || link.label || link.id;

// React list key. The POSITION is part of it because nothing dedupes the stored
// array: brain records sync raw between installs with no receive-side
// validation, so a record can legitimately arrive holding the same {type,id}
// twice, and a pure identity key would collide. Removal is likewise by index,
// so deleting one duplicate doesn't take its twin with it.
const rowKey = (link, index) => `${songLinkKey(link)}#${index}`;

export function SongLinkChips({ links, className = '' }) {
  if (!links?.length) return null;
  return (
    <div className={`flex flex-wrap items-center gap-2 text-xs ${className}`}>
      {links.map((link, i) => {
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
            key={rowKey(link, i)}
            to={href}
            className="flex items-center gap-1 px-2 py-1 rounded-full bg-port-bg border border-port-border text-port-accent hover:border-port-accent/50"
          >
            {inner}
          </Link>
        ) : (
          <span
            key={rowKey(link, i)}
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
  // A rounds/tracks outage must not block editing the SONG, so a failed read
  // shows a retryable error for that kind instead of "none available".
  const rounds = useListResource(fetchRounds);
  const tracks = useListResource(fetchTracks);
  const [type, setType] = useState(SONG_LINK_TYPES[0].id);
  const [targetId, setTargetId] = useState('');

  const recordsByType = useMemo(() => ({ round: rounds.items, track: tracks.items }), [rounds.items, tracks.items]);

  // Options for the currently selected type, minus anything already linked.
  const linked = useMemo(() => new Set(links.map(songLinkKey)), [links]);
  const options = useMemo(() => (
    (recordsByType[type] || [])
      .filter((r) => r?.id && !linked.has(songLinkKey({ type, id: r.id })))
      .map((r) => ({ id: r.id, title: r.title || r.id }))
  ), [recordsByType, type, linked]);

  // Titles for rows whose target IS present locally, so a renamed record shows
  // its current name instead of the label frozen at link time.
  const freshTitles = useMemo(() => {
    const map = new Map();
    for (const [kind, records] of Object.entries(recordsByType)) {
      for (const r of records || []) {
        if (r?.id && r.title) map.set(songLinkKey({ type: kind, id: r.id }), r.title);
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

  // By INDEX, not by identity — see rowKey: a synced record can hold the same
  // {type,id} twice, and filtering on identity would delete both at once.
  const remove = (index) => onChange(links.filter((_, i) => i !== index));

  const { state, error, retry } = type === 'track' ? tracks : rounds;
  const loading = state === 'loading';

  return (
    <div>
      <span className={labelClass}>Linked records</span>

      {links.length > 0 && (
        <ul className="space-y-1 mb-2">
          {links.map((link, i) => {
            const text = linkText(link, freshTitles.get(songLinkKey(link)));
            return (
              <li
                key={rowKey(link, i)}
                className="flex items-center gap-2 px-3 py-2 bg-port-card border border-port-border rounded-lg text-sm"
              >
                <span className="shrink-0 text-xs text-gray-500">{songLinkTypeLabel(link.type)}</span>
                <span className="flex-1 min-w-0 truncate text-gray-200">{text}</span>
                <button
                  type="button"
                  onClick={() => remove(i)}
                  className="pointer-coarse:min-h-11 pointer-coarse:min-w-11 p-1 shrink-0 text-gray-500 hover:text-port-error"
                  aria-label={`Remove link to ${text}`}
                >
                  <X size={14} />
                </button>
              </li>
            );
          })}
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
            disabled={state !== 'ready' || options.length === 0}
            className={inputClass}
          >
            <option value="">
              {loading ? 'Loading…' : state === 'error' ? 'Unavailable' : options.length === 0 ? `No ${songLinkTypeLabel(type).toLowerCase()}s available` : 'Select…'}
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
      {state === 'error' && (
        <ListLoadError what={`${songLinkTypeLabel(type).toLowerCase()}s`} error={error} onRetry={retry} className="mt-2" />
      )}
    </div>
  );
}
