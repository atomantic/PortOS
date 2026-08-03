import { useCallback, useMemo } from 'react';
import toast from '../components/ui/Toast';
import { VOICE_LAYERS } from '../lib/songCraft';
import { SCORE_PARTS_MAX, localId } from '../lib/roundDraft.js';

/**
 * Row-level edits on a Round draft — lyric sections, voice layers, reference
 * material, and the harmony parts an audio analysis proposes. Every mutation
 * lands in the in-memory draft only; the page's Save button persists it.
 *
 * Freshly added rows carry a temp id (`localId`) that `buildRoundPatch` strips on
 * save so the server mints a stable uuid. Layer PRESETS are the exception: they
 * carry the stable bare preset id (`lead`), which is what keeps
 * `remainingPresets` dedup working across a save.
 *
 * @param {object} args
 * @param {object|null} args.song The current draft.
 * @param {Function} args.setSong The draft setter from `useRoundDraft`.
 */
export default function useRoundRows({ song, setSong }) {
  // --- Section helpers ----------------------------------------------------
  const addSection = useCallback(() => setSong((prev) => ({
    ...prev,
    sections: [...(prev.sections || []), { id: localId('sec'), label: 'Section', lyrics: '' }],
  })), [setSong]);
  const updateSection = useCallback((sid, key, value) => setSong((prev) => ({
    ...prev,
    sections: prev.sections.map((s) => (s.id === sid ? { ...s, [key]: value } : s)),
  })), [setSong]);
  const removeSection = useCallback((sid) => setSong((prev) => ({
    ...prev, sections: prev.sections.filter((s) => s.id !== sid),
  })), [setSong]);

  // --- Layer helpers ------------------------------------------------------
  const addLayer = useCallback((preset) => setSong((prev) => ({
    ...prev,
    // Presets carry the STABLE bare preset id (`lead`) — the picker already
    // prevents adding the same preset twice, so it's unique among layers, it
    // survives save (not a temp id), and it keeps remainingPresets dedup
    // working. Blank layers use a temp id stripped on save.
    layers: [...(prev.layers || []), preset
      ? { id: preset.id, label: preset.label, part: preset.voices, notes: preset.advice }
      : { id: localId('layer'), label: 'Layer', part: '', notes: '' }],
  })), [setSong]);
  const updateLayer = useCallback((lid, key, value) => setSong((prev) => ({
    ...prev,
    layers: prev.layers.map((l) => (l.id === lid ? { ...l, [key]: value } : l)),
  })), [setSong]);
  const removeLayer = useCallback((lid) => setSong((prev) => ({
    ...prev, layers: prev.layers.filter((l) => l.id !== lid),
  })), [setSong]);

  // --- Reference helpers --------------------------------------------------
  const addReference = useCallback(() => setSong((prev) => ({
    ...prev,
    references: [...(prev.references || []), { id: localId('ref'), url: '', label: '', note: '' }],
  })), [setSong]);
  const updateReference = useCallback((rid, key, value) => setSong((prev) => ({
    ...prev,
    references: prev.references.map((r) => (r.id === rid ? { ...r, [key]: value } : r)),
  })), [setSong]);
  const removeReference = useCallback((rid) => setSong((prev) => ({
    ...prev, references: prev.references.filter((r) => r.id !== rid),
  })), [setSong]);

  // Apply an extracted reference part into the DRAFT (#2106). `base: true`
  // updates the round's base melody (song.score); otherwise an `id` targeting
  // an existing part replaces its score, and anything else is appended with a
  // temp id (stripped on save). Nothing persists until the header Save — the
  // same explicit-save model as recordings and AI derive.
  const applyProposedPart = useCallback((part) => {
    if (part.base) {
      setSong((prev) => (prev ? { ...prev, score: part.score } : prev));
      toast.success('Base melody updated in the draft — Save the song to keep it');
      return;
    }
    const parts = song?.scoreParts || [];
    const exists = part.id && parts.some((p) => p.id === part.id);
    if (!exists && parts.length >= SCORE_PARTS_MAX) {
      toast.error(`This round already has ${SCORE_PARTS_MAX} parts — remove one first.`);
      return;
    }
    setSong((prev) => {
      const cur = prev.scoreParts || [];
      if (part.id && cur.some((p) => p.id === part.id)) {
        return { ...prev, scoreParts: cur.map((p) => (p.id === part.id ? { ...p, score: part.score } : p)) };
      }
      return {
        ...prev,
        scoreParts: [...cur, { id: localId('part'), label: part.label || 'Part', role: part.role || '', score: part.score }],
      };
    });
    toast.success('Part applied to the draft — Save the song to keep it');
  }, [song?.scoreParts, setSong]);

  // Layer presets the user hasn't added yet, in foundation-first order. Match
  // on the preset id: preset layers (seed or ladder-added) carry the bare
  // preset id like `lead`, so renaming a layer's label can't make its preset
  // reappear and two presets sharing a label can't collide.
  const remainingPresets = useMemo(() => {
    const have = new Set((song?.layers || []).map((l) => l.id));
    return VOICE_LAYERS.filter((p) => !have.has(p.id));
  }, [song?.layers]);

  return {
    addSection, updateSection, removeSection,
    addLayer, updateLayer, removeLayer,
    addReference, updateReference, removeReference,
    applyProposedPart, remainingPresets,
  };
}
