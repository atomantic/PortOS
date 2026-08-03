import { useCallback, useEffect, useMemo, useState } from 'react';
import { listRounds } from '../services/api';
import { PARTNERS_MAX } from '../lib/roundDraft.js';

/**
 * Round partners — the rounds sung at the same time as the open one (the
 * quodlibet "Sings with" links that feed the stacked-parts view).
 *
 * The all-songs list is re-fetched whenever the open song changes: the page
 * stays mounted across `/rounds/:id` navigation, so a once-on-mount fetch would
 * leave partner records (titles, saved takes) stale after editing a partner and
 * navigating back. The list is small and single-user, so re-fetching on
 * navigation is cheap and keeps the round stack honest. Best-effort — the page
 * degrades to no partner resolution if it fails.
 *
 * @param {object} args
 * @param {string} args.id The open round's id.
 * @param {object|null} args.song The current draft (read for `partnerRoundIds`).
 * @param {Function} args.setSong The draft setter from `useRoundDraft`.
 */
export default function useRoundPartners({ id, song, setSong }) {
  const [allSongs, setAllSongs] = useState([]);

  useEffect(() => {
    let cancelled = false;
    listRounds({ silent: true })
      .then((data) => { if (!cancelled) setAllSongs(data?.rounds || []); })
      .catch(() => { /* the page degrades to no partner resolution */ });
    return () => { cancelled = true; };
  }, [id]);

  // Resolve this song's partner ids to records (skip any that no longer exist).
  const partnerSongs = useMemo(() => {
    const byId = new Map(allSongs.map((s) => [s.id, s]));
    return (song?.partnerRoundIds || []).map((pid) => byId.get(pid)).filter(Boolean);
  }, [allSongs, song?.partnerRoundIds]);

  // Other songs to offer as partners in the editor, alphabetical.
  const otherSongs = useMemo(
    () => allSongs.filter((s) => s.id !== id).sort((a, b) => (a.title || '').localeCompare(b.title || '')),
    [allSongs, id],
  );

  const togglePartner = useCallback((pid) => setSong((prev) => {
    if (!prev) return prev;
    const cur = prev.partnerRoundIds || [];
    if (cur.includes(pid)) return { ...prev, partnerRoundIds: cur.filter((x) => x !== pid) };
    if (cur.length >= PARTNERS_MAX) return prev;
    return { ...prev, partnerRoundIds: [...cur, pid] };
  }), [setSong]);

  return { allSongs, partnerSongs, otherSongs, togglePartner };
}
