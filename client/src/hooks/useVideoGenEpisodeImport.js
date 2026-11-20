/**
 * Episode Composer route state on /media/video: `?episode=1` opens it, and `loomId`/`episodeId` import a FableLoom episode's scenes.
 *
 * Use when: The VideoGen page opens the multi-scene composer (#6228), directly or from
 * FableLoom's "Open Episode Composer" link. A failed read is surfaced, never shown as an
 * episode with no scenes.
 */

import { useEffect, useState } from 'react';
import { getLoom } from '../services/apiFableLoom.js';
import { loomEpisodeToDraftScenes } from '../lib/episodeSceneImport.js';

export function useVideoGenEpisodeImport({ searchParams, setSearchParams }) {
  const episodeOpen = searchParams.get('episode') === '1';
  const episodeLoomId = searchParams.get('loomId');
  const episodeEpisodeId = searchParams.get('episodeId');
  const openEpisodeComposer = () => setSearchParams(prev => { const n = new URLSearchParams(prev); n.set('episode', '1'); return n; });
  const closeEpisodeComposer = () => {
    setSearchParams(prev => {
      const n = new URLSearchParams(prev);
      n.delete('episode'); n.delete('loomId'); n.delete('episodeId');
      return n;
    });
  };
  // The import is stored with the target it was read for, so a switch to
  // another episode never shows the previous episode's scenes — even when the
  // new episode has none.
  const episodeImportKey = episodeOpen && episodeLoomId && episodeEpisodeId
    ? JSON.stringify([episodeLoomId, episodeEpisodeId])
    : null;
  const [episodeImport, setEpisodeImport] = useState(null);
  const episodeImportScenes = episodeImport && episodeImport.key === episodeImportKey ? episodeImport.scenes : null;
  // A failed FableLoom read must not open as a blank composer the user takes
  // for an episode with no scenes.
  const [episodeImportError, setEpisodeImportError] = useState(null);
  const [episodeImportPending, setEpisodeImportPending] = useState(false);
  const [episodeImportAttempt, setEpisodeImportAttempt] = useState(0);
  useEffect(() => {
    if (!episodeOpen || !episodeLoomId || !episodeEpisodeId) {
      // Browser Back can drop the import params without closeEpisodeComposer;
      // a later plain open must not inherit the old import or its failure.
      setEpisodeImport(null);
      setEpisodeImportError(null);
      setEpisodeImportPending(false);
      return undefined;
    }
    let active = true;
    // The failure stays visible until a read succeeds, so Retry never shows
    // the blank composer as if the episode had no scenes.
    setEpisodeImportPending(true);
    getLoom(episodeLoomId, { silent: true }).then((loom) => {
      if (!active) return;
      const episode = loom?.episodes?.find((e) => e.id === episodeEpisodeId);
      if (!episode) {
        setEpisodeImportError(new Error('it is no longer in this loom; reopen the composer from FableLoom'));
        return;
      }
      setEpisodeImport({ key: episodeImportKey, scenes: loomEpisodeToDraftScenes(episode, { format: loom?.format }) });
      setEpisodeImportError(null);
    }).catch((error) => {
      if (active) setEpisodeImportError(error);
    }).finally(() => {
      if (active) setEpisodeImportPending(false);
    });
    return () => { active = false; };
    // Only re-run when a fresh loom/episode is targeted, not on every render.
    // Dependency list is intentionally partial.
  }, [episodeOpen, episodeLoomId, episodeEpisodeId, episodeImportKey, episodeImportAttempt]);

  return {
    episodeOpen, openEpisodeComposer, closeEpisodeComposer,
    episodeImportKey, episodeImportScenes, episodeImportError, episodeImportPending,
    retryEpisodeImport: () => setEpisodeImportAttempt((n) => n + 1),
  };
}

export default useVideoGenEpisodeImport;
