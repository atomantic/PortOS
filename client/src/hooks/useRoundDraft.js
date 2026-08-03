import { useCallback, useEffect, useMemo, useState } from 'react';
import toast from '../components/ui/Toast';
import { useAsyncAction } from './useAsyncAction';
import { getRound, updateRound, refreshRoundTemplate } from '../services/api';
import { buildRoundPatch } from '../lib/roundDraft.js';

/**
 * The Round editor's draft lifecycle (`/rounds/:id`): load the server record,
 * hold the in-memory draft, and persist it.
 *
 * Saves are explicit (a Save button) rather than per-keystroke — the workbench
 * is a focused editing surface, and a single PUT keeps the merge simple.
 *
 * `savedBase` snapshots the last server-persisted base melody (score + key) so
 * `baseDirty` can gate the AI "Derive harmony parts" action, which reads the
 * SAVED score server-side (the project's "Run Now actions gate on saved state"
 * rule). It is re-snapshotted wherever a canonical server song lands (load,
 * save, refresh-from-template).
 *
 * `analyzeId` / `setAnalyze` are threaded in because saving re-ids a freshly
 * added reference, which has to re-point an open `?analyze=` deep link.
 *
 * @param {object} args
 * @param {string} args.id The round id from the route.
 * @param {string|null} args.analyzeId The open reference-analysis id, if any.
 * @param {(refId: string|null) => void} args.setAnalyze Re-points that deep link.
 */
export default function useRoundDraft({ id, analyzeId, setAnalyze }) {
  const [song, setSong] = useState(null);
  const [loading, setLoading] = useState(true);
  const [savedBase, setSavedBase] = useState({ score: '', key: '' });

  // Adopt a server-canonical song: set the draft AND snapshot its saved base.
  const setServerSong = useCallback((s) => {
    setSong(s);
    setSavedBase({ score: s?.score || '', key: s?.key || '' });
  }, []);

  useEffect(() => {
    let cancelled = false;
    // Reset to the loading state on every id change — partner links navigate
    // song→song without unmounting the page, so without this the previous
    // draft would render under the new id and a Save during the load window would
    // write the old draft into the new song's record. The page's loading guard
    // hides the editor (and its Save button) until the new song arrives.
    setLoading(true);
    setSong(null);
    getRound(id, { silent: true })
      .then((data) => { if (!cancelled) setServerSong(data?.round || null); })
      .catch((err) => { if (!cancelled) toast.error(err?.message || 'Failed to load round'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [id, setServerSong]);

  // Field setters merge into the in-memory draft; nothing persists until Save.
  const setField = useCallback((key, value) => {
    setSong((prev) => (prev ? { ...prev, [key]: value } : prev));
  }, []);

  const [save, saving] = useAsyncAction(async () => {
    const data = await updateRound(id, buildRoundPatch(song), { silent: true });
    if (data?.round) {
      setServerSong(data.round);
      // Saving strips temp reference ids, so a freshly-added reference gets a
      // new server uuid — re-point an open ?analyze= deep link at its saved
      // twin (matched by url + audioFilename) instead of stranding the
      // workbench on a "no longer exists" fallback.
      if (analyzeId && !(data.round.references || []).some((r) => r.id === analyzeId)) {
        const old = (song.references || []).find((r) => r.id === analyzeId);
        const twin = old && (data.round.references || []).find(
          (r) => r.url === old.url && (r.audioFilename || '') === (old.audioFilename || ''),
        );
        setAnalyze(twin ? twin.id : null);
      }
    }
    toast.success('Round saved');
    return data?.round;
  }, { errorMessage: 'Failed to save round' });

  // Restore a built-in default to its shipped content (lyrics, layers,
  // references). Persists server-side immediately and preserves the user's
  // recordings + learned progress; replaces any local unsaved edits, so the
  // BuiltInBanner gates this behind an inline confirm.
  const [refreshTemplate, refreshing] = useAsyncAction(async () => {
    const data = await refreshRoundTemplate(id, { silent: true });
    if (data?.round) setServerSong(data.round);
    toast.success('Refreshed from the bundled template');
    return data?.round;
  }, { errorMessage: 'Failed to refresh from template' });

  // Merge an AI-generated draft into the editor. The server returns canonical
  // fields with server-assigned ids; we replace the editable content (metadata,
  // sections, layers, notation, notes) but PRESERVE the user's recordings and
  // `learned` flag — those aren't the model's to overwrite. Nothing persists
  // until the user hits Save (matches the universe-builder review-then-commit
  // flow). The server already folded any prior draft in when expanding, so we
  // simply apply the returned fields.
  const applyGenerated = useCallback((generated) => {
    setSong((prev) => ({
      ...prev,
      title: generated.title || prev.title,
      artist: generated.artist ?? prev.artist,
      key: generated.key ?? prev.key,
      tempo: generated.tempo ?? prev.tempo,
      rhythmShapeId: generated.rhythmShapeId ?? prev.rhythmShapeId,
      notation: generated.notation ?? prev.notation,
      notes: generated.notes ?? prev.notes,
      sections: Array.isArray(generated.sections) ? generated.sections : prev.sections,
      layers: Array.isArray(generated.layers) ? generated.layers : prev.layers,
    }));
  }, []);

  // True while the base melody carries unsaved edits — the AI derive reads the
  // SAVED score, so it must be disabled until this clears.
  const baseDirty = useMemo(
    () => (song?.score || '') !== savedBase.score || (song?.key || '') !== savedBase.key,
    [song?.score, song?.key, savedBase],
  );

  return {
    song, setSong, loading, savedBase, baseDirty,
    setField, save, saving, refreshTemplate, refreshing, applyGenerated,
  };
}
