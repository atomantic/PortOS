/**
 * VideoGen record handoffs into the form: in-page and cross-page (`?remix=<id>`) Remix, Finish-a-draft, and Continue.
 *
 * Use when: The /media/video page restores a saved render's settings. Every path replays the
 * record through the form's one `applyRemix`, so a restore never drifts from what the gallery
 * Remix restores (#6290).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { getVideoHistoryItem } from '../services/apiImageVideo.js';
import { finishTargetForRecord } from '../lib/videoFinish.js';
import { MUSIC_VIDEO_FILING_PARAM, musicVideoOf } from '../lib/musicVideoFiling';
import useMediaPreviewActions from './useMediaPreviewActions';

/**
 * `historyState` is `useVideoGenHistory()`'s load sentinel and refresh; the
 * handoff waits on it before it calls a record missing.
 */
export function useVideoGenRemixHandoff({
  searchParams, setSearchParams, models, applyRemix, applyFinish, historyState,
}) {
  const { history, historyLoad, setHistoryLoad, historyInFlightRef, refreshHistory } = historyState;
  // "Continue" is the same action here as on every other media surface (extract
  // the last frame, open the form on it with the source's prompt), so it comes
  // from the shared hook rather than a page-local copy. It takes the normalized
  // shape — gallery callers hand over raw history records, so they normalize.
  const { handleContinue } = useMediaPreviewActions();

  // Remix a prior render: hand all its params back into the form (the hook
  // owns the field-by-field restore) and scroll the form back into view.
  const handleRemixVideo = useCallback((item) => {
    const raw = item?.raw || item;
    if (!raw) return;
    applyRemix(raw);
    // A clip made for a music video keeps its remix in that video's collection.
    const projectId = musicVideoOf(raw);
    if (projectId) setSearchParams((prev) => { const n = new URLSearchParams(prev); n.set(MUSIC_VIDEO_FILING_PARAM, projectId); return n; }, { replace: true });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, [applyRemix, setSearchParams]);

  // Cross-page Remix (#6290). Media History (and every other MediaPreview
  // surface) hands this page a RECORD ID rather than a render-settings bundle,
  // so the restore runs through the same `applyRemix` the in-page gallery uses
  // — one implementation that knows every field the record carries, instead of
  // a URL enumeration that silently dropped the encoder, speed profile, draft
  // decode and LoRAs. `history` is the unfiltered load, so a hidden record
  // resolves too.
  //
  // One ref carries the whole "has this handoff been dealt with?" question, and
  // it holds the handoff ID rather than a boolean, so a SECOND handoff arriving
  // on the same mount is still honored. It is what makes the restore one-shot —
  // not the stripped parameter, which lands on an async router update a
  // completion refresh in the same tick could beat, re-applying the handoff over
  // edits the user has made since.
  //
  // A FAILED fetch settles the handoff too, deliberately: the restore then waits
  // for the explicit Retry (which clears the ref) instead of riding in on the
  // next background refresh, since a render completing minutes later would
  // otherwise replay it over a form the user has been editing the whole time.
  const remixHandoffId = searchParams.get('remix');
  const settledRemixHandoffRef = useRef(null);
  // null while nothing is wrong; otherwise 'error' (the history fetch failed,
  // retryable) or 'missing' (history loaded and holds no such record).
  const [remixHandoffProblem, setRemixHandoffProblem] = useState(null);
  // The restore waits on a history round trip, so unlike the old URL bundle
  // (applied synchronously on mount) there is a window in which the form still
  // holds the page defaults and is about to be replaced wholesale. Announce it
  // and hold Generate: rendering here would spend GPU time on the defaults while
  // the user believes they are looking at the clip's settings. The window runs
  // from the parameter appearing until the handoff either restores (which strips
  // it) or reports a problem — which also covers the wait on a sibling fetch
  // below, with no second sentinel. Retry re-enters it by clearing the problem.
  const remixHandoffPending = !!remixHandoffId && !remixHandoffProblem;
  const consumeRemixHandoff = useCallback(() => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.delete('remix');
      return next;
    }, { replace: true });
  }, [setSearchParams]);
  // The page loads only the newest history page, so an older clip is hydrated
  // by id before it is called missing. The handoff id is already marked
  // settled, so a history refresh mid-flight cannot start a second lookup; a
  // handoff that changed or cleared meanwhile resets that ref, which makes the
  // answer stale.
  const hydrateOlderRemix = useCallback((id) => {
    const current = () => settledRemixHandoffRef.current === id;
    getVideoHistoryItem(id, { silent: true })
      .then((older) => {
        if (!current()) return;
        applyRemix(older);
        setRemixHandoffProblem(null);
        consumeRemixHandoff();
      })
      .catch((err) => {
        if (!current()) return;
        // Only a 404 means the clip is gone; any other failure keeps the param so Retry resolves it.
        if (err?.status === 404) { setRemixHandoffProblem('missing'); consumeRemixHandoff(); } else setRemixHandoffProblem('error');
      });
  }, [applyRemix, consumeRemixHandoff]);
  useEffect(() => {
    // No handoff in the URL — including right after this one consumed its own.
    // Clearing the settled id here is what lets the NEXT handoff through, even
    // when it names the same record.
    if (!remixHandoffId) { settledRemixHandoffRef.current = null; return; }
    if (settledRemixHandoffRef.current === remixHandoffId) return;
    // Still fetching: say nothing. Reporting "no such record" here would be a
    // lie every time the page is opened faster than the history round trip.
    // Any banner still up belongs to a previous handoff, so it goes.
    if (historyLoad === 'loading') { setRemixHandoffProblem(null); return; }
    // The sentinel is shared with the completion refresh, so an 'error' may
    // belong to a background fetch that failed alongside the one this handoff is
    // actually waiting on. Keep waiting while any fetch is still running, or a
    // transient blip on the sibling would strand a handoff the in-flight request
    // is about to satisfy.
    if (historyLoad === 'error' && historyInFlightRef.current > 0) return;
    settledRemixHandoffRef.current = remixHandoffId;
    if (historyLoad === 'error') {
      // Keep the param in the URL — Retry resolves this same handoff.
      setRemixHandoffProblem('error');
      return;
    }
    const record = history.find((v) => String(v.id) === remixHandoffId);
    if (record) {
      applyRemix(record);
      setRemixHandoffProblem(null);
      consumeRemixHandoff();
      return;
    }
    hydrateOlderRemix(remixHandoffId);
  }, [remixHandoffId, historyLoad, history, applyRemix, consumeRemixHandoff, hydrateOlderRemix]);
  // Back to 'loading' first, so a retry that fails again still moves the state
  // ('loading' → 'error') and re-runs the effect above.
  const retryRemixHandoff = useCallback(() => {
    settledRemixHandoffRef.current = null;
    setHistoryLoad('loading');
    setRemixHandoffProblem(null);
    refreshHistory();
  }, [refreshHistory]);
  const dismissRemixHandoff = useCallback(() => {
    settledRemixHandoffRef.current = remixHandoffId;
    setRemixHandoffProblem(null);
    consumeRemixHandoff();
  }, [remixHandoffId, consumeRemixHandoff]);

  // Finish a draft (#3696): same restore as Remix, but switched to the delivery
  // model the draft's registry entry declares. Prefill only — the user presses
  // Generate themselves.
  const resolveFinishTarget = useCallback((raw) => finishTargetForRecord(raw, models), [models]);
  const handleFinishVideo = useCallback((raw, target) => {
    if (!raw || !target) return;
    applyFinish(raw, target.id);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, [applyFinish]);
  const handleContinueVideo = useCallback((item) => handleContinue(item), [handleContinue]);

  return {
    remixHandoffPending, remixHandoffProblem, retryRemixHandoff, dismissRemixHandoff,
    handleRemixVideo, handleContinue, handleContinueVideo, resolveFinishTarget, handleFinishVideo,
  };
}

export default useVideoGenRemixHandoff;
