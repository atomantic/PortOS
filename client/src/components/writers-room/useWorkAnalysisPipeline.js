import { useCallback, useEffect, useRef, useState } from 'react';
import {
  listWritersRoomCharacters, listWritersRoomObjects, listWritersRoomPlaces, runWritersRoomAnalysis,
} from '../../services/apiWritersRoom';
import toast from '../ui/Toast';

export const ANALYSIS_KIND = { SCRIPT: 'script', CHARACTERS: 'characters', PLACES: 'places', OBJECTS: 'objects', EVALUATE: 'evaluate', FORMAT: 'format' };
export const ANALYSIS_LABELS = {
  [ANALYSIS_KIND.SCRIPT]: 'Adapt',
  [ANALYSIS_KIND.CHARACTERS]: 'Characters',
  [ANALYSIS_KIND.PLACES]: 'Places',
  [ANALYSIS_KIND.OBJECTS]: 'Objects',
  [ANALYSIS_KIND.EVALUATE]: 'Editorial pass',
  [ANALYSIS_KIND.FORMAT]: 'Format pass',
};

// Bible rosters read per work. A failed read is a distinct status, never an
// empty list: an empty array is "no records" only once its status is 'ready'.
const BIBLE_READERS = {
  characters: listWritersRoomCharacters,
  places: listWritersRoomPlaces,
  objects: listWritersRoomObjects,
};
const BIBLE_LOADING = { characters: 'loading', places: 'loading', objects: 'loading' };

export default function useWorkAnalysisPipeline({
  workId, bodyRef, savedBodyRef, ownerKeyRef, draftTransitionRef, savingRef, mountedRef, setBody,
  polishBusy, exercisePending,
}) {
  const [characters, setCharacters] = useState([]);
  const [places, setPlaces] = useState([]);
  const [objects, setObjects] = useState([]);
  const [bibleStatus, setBibleStatus] = useState(BIBLE_LOADING);
  // Per-kind request generation: only the newest read for a kind may land.
  const bibleGenRef = useRef({ characters: 0, places: 0, objects: 0 });
  const workIdRef = useRef(workId);
  workIdRef.current = workId;
  const [runningKind, setRunningKind] = useState(null);
  const [runStartedAt, setRunStartedAt] = useState(null);

  // The CharactersBible / PlacesBible drawers are the canonical editors;
  // mirror their lists here so the storyboard's image-prompt enrichment picks
  // up edits immediately.
  //
  // `active` is load-bearing, not hygiene. WorkEditor is rendered without a
  // `key` (WritersRoom.jsx), so it stays mounted across a work swap and this
  // effect merely re-fires. Without the guard, a slow bible read for work A
  // lands after the swap and sticks: these lists are passed down as controlled
  // props, and BibleSection returns early rather than refetching when it gets
  // them, so nothing re-reads the server until the user re-runs an extraction.
  // In the meantime StoryboardPanel enriches work B's image-gen prompts with
  // work A's characters and places, and those renders are persisted.
  const setBibleRows = useCallback((kind, rows) => {
    if (kind === 'characters') setCharacters(rows);
    else if (kind === 'places') setPlaces(rows);
    else setObjects(rows);
  }, []);

  // A read that fails keeps the rows of the last successful read and surfaces
  // an error status (retryable per kind) instead of installing an empty list.
  const readBible = useCallback((kind, workId) => {
    const gen = ++bibleGenRef.current[kind];
    setBibleStatus((prev) => ({ ...prev, [kind]: 'loading' }));
    return BIBLE_READERS[kind](workId).then((rows) => {
      if (gen !== bibleGenRef.current[kind]) return;
      setBibleRows(kind, rows || []);
      setBibleStatus((prev) => ({ ...prev, [kind]: 'ready' }));
    }).catch(() => {
      if (gen !== bibleGenRef.current[kind]) return;
      setBibleStatus((prev) => ({ ...prev, [kind]: 'error' }));
    });
  }, [setBibleRows]);

  // An extraction result is the full merged roster: it supersedes any read in
  // flight and clears a prior load error.
  const applyBibleRows = useCallback((kind, rows) => {
    bibleGenRef.current[kind] += 1;
    setBibleRows(kind, rows);
    setBibleStatus((prev) => ({ ...prev, [kind]: 'ready' }));
  }, [setBibleRows]);

  const retryBible = useCallback((kind) => readBible(kind, workIdRef.current), [readBible]);

  useEffect(() => {
    let active = true;
    // The previous work's rosters never stay visible while this one loads.
    setCharacters([]);
    setPlaces([]);
    setObjects([]);
    Object.keys(BIBLE_READERS).forEach((kind) => { if (active) readBible(kind, workId); });
    return () => {
      active = false;
      // Invalidate every in-flight read, including a retry started on this work.
      Object.keys(bibleGenRef.current).forEach((kind) => { bibleGenRef.current[kind] += 1; });
    };
  }, [workId, readBible]);

  // debug menu all funnel through here so we get one toast + state pattern.
  // Format pass replaces the prose buffer (apply-on-success) — the user can
  // back out by simply not saving. Characters refreshes the bible cache so
  // the storyboard's prompt enrichment picks up new profiles immediately.
  const runAnalysis = useCallback(async (kind) => {
    if (runningKind || draftTransitionRef.current || savingRef.current || polishBusy || exercisePending) return false;
    const startOwner = ownerKeyRef.current;
    const startBody = bodyRef.current;
    // Analysis reads the SAVED draft, so a buffer that was already dirty is not what gets formatted.
    const startedClean = startBody === savedBodyRef.current;
    setRunningKind(kind);
    setRunStartedAt(Date.now());
    const snapshot = await runWritersRoomAnalysis(workId, { kind }, { silent: true }).catch((err) => {
      if (mountedRef.current) toast.error(`${ANALYSIS_LABELS[kind] || kind} failed: ${err.message}`);
      return null;
    });
    if (!mountedRef.current) {
      setRunningKind(null);
      setRunStartedAt(null);
      return false;
    }
    setRunningKind(null);
    setRunStartedAt(null);
    if (!snapshot) return false;
    // The writer moved to another work/draft while this ran; its result belongs
    // to the old owner and must not touch the current buffer or bible lists.
    if (ownerKeyRef.current !== startOwner || draftTransitionRef.current) return false;
    if (snapshot.status === 'failed') {
      toast.error(`${ANALYSIS_LABELS[kind] || kind} failed: ${snapshot.error || 'unknown'}`);
      return false;
    }
    toast.success(`${ANALYSIS_LABELS[kind] || kind} complete`);
    if (kind === 'characters' && Array.isArray(snapshot.result?.mergedProfiles)) {
      applyBibleRows('characters', snapshot.result.mergedProfiles);
    }
    if (kind === 'places' && Array.isArray(snapshot.result?.mergedProfiles)) {
      applyBibleRows('places', snapshot.result.mergedProfiles);
    }
    if (kind === 'objects' && Array.isArray(snapshot.result?.mergedProfiles)) {
      applyBibleRows('objects', snapshot.result.mergedProfiles);
    }
    if (kind === 'format' && snapshot.result?.formattedBody) {
      // Apply only if the buffer is untouched since the pass started. Comparing
      // text (not just a dirty flag) also catches edit-then-save, where the
      // buffer is clean again but no longer the analyzed source. The result
      // stays in Analysis history for explicit application.
      if (!startedClean || bodyRef.current !== startBody) {
        toast('Format result not applied — you edited the draft meanwhile. Apply it from Analysis history.', { icon: 'ℹ️' });
      } else {
        setBody(snapshot.result.formattedBody);
        toast('Format applied to draft buffer — save to persist', { icon: '💾' });
      }
    }
    return true;
  }, [runningKind, workId, polishBusy, exercisePending, applyBibleRows]);

  // Sequential pipeline for the 3-step storyboard setup. Run characters →
  // places → script in order so each later step has the earlier bible to
  // reference. Bails on first failure (the failed step's toast already fired).
  const runFullPipeline = useCallback(async () => {
    if (runningKind) return;
    const okChars = await runAnalysis(ANALYSIS_KIND.CHARACTERS);
    if (!okChars || !mountedRef.current) return;
    const okPlaces = await runAnalysis(ANALYSIS_KIND.PLACES);
    if (!okPlaces || !mountedRef.current) return;
    await runAnalysis(ANALYSIS_KIND.SCRIPT);
  }, [runAnalysis, runningKind]);

  // StoryboardPanel is memoized (#3387) — it only skips a re-render while every
  // prop it receives is referentially stable, so its handlers cannot be inline
  // arrows. These four are the ones that used to be recreated per render (and
  // therefore per keystroke); the rest are state setters, refs, or callbacks
  // already keyed on non-typing deps.
  const runAdapt = useCallback(() => runAnalysis(ANALYSIS_KIND.SCRIPT), [runAnalysis]);
  const runCharacters = useCallback(() => runAnalysis(ANALYSIS_KIND.CHARACTERS), [runAnalysis]);
  const runPlaces = useCallback(() => runAnalysis(ANALYSIS_KIND.PLACES), [runAnalysis]);
  const runObjects = useCallback(() => runAnalysis(ANALYSIS_KIND.OBJECTS), [runAnalysis]);

  return {
    characters, setCharacters, places, setPlaces, objects, setObjects, bibleStatus, retryBible,
    runningKind, runStartedAt, runAnalysis, runAdapt, runCharacters, runPlaces, runObjects, runFullPipeline,
  };
}
