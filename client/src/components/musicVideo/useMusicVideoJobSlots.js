import { useEffect, useRef, useState } from 'react';
import toast from '../ui/Toast';
import {
  analyzeMusicVideoProject,
  getMusicVideoActiveJobs,
  getMusicVideoProject,
  prepareMusicVideoSong,
} from '../../services/apiMusicVideo.js';
import useMusicVideoYoutubeImport from '../../hooks/useMusicVideoYoutubeImport.js';
import useMusicVideoMidiJob from '../../hooks/useMusicVideoMidiJob.js';
import useMusicVideoLyricAlign from '../../hooks/useMusicVideoLyricAlign.js';
import useMusicVideoVocalSeparation, { separatedStemPatch } from '../../hooks/useMusicVideoVocalSeparation.js';
import useMusicVideoRenderJob from '../../hooks/useMusicVideoRenderJob.js';
import useMusicVideoPublishing from '../../hooks/useMusicVideoPublishing.js';
import useMusicVideoModelSettings from '../../hooks/useMusicVideoModelSettings.js';

// Word-anchored shots follow their words on the server when lyric timing changes (#14820), so take their new spans.
export const wordAnchoredShots = (project) => ((project?.scenes || []).some((scene) => scene.lyricAnchor)
  ? { scenes: project.scenes, productionReview: project.productionReview, lyricAnchorSync: project.lyricAnchorSync ?? null } : {});

/**
 * The page-wide job slots and install-wide catalogs that must outlive a project
 * switch (the workspace below is keyed per project): track import, vocal
 * separation, lyric alignment, MIDI, the final render, the video-model catalog
 * and the publish platforms. Each binds to its project by id itself.
 */
export default function useMusicVideoJobSlots({
  routeProjectId, navigate, selected, selectedId, onTrackImported, onCreateComplete, replaceProject, patchProject,
}) {
  const [analyzing, setAnalyzing] = useState(false);
  const youtube = useMusicVideoYoutubeImport({
    routeProjectId,
    navigate,
    onTrackImported,
    onCreateComplete,
    onProjectUpdated: (proj) => { replaceProject(proj); prepareSong(proj.id); },
  });
  // "Separate vocals" (demucs) — one slot shared by the stem control and the
  // autopilot kickoff; the terminal frame carries the project with its stem.
  const separation = useMusicVideoVocalSeparation({
    onSeparated: (projectId, project) => patchProject(projectId, separatedStemPatch(project)),
  });
  // Projects whose director chose "Re-analyze & re-time" (#14793): once their alignment lands, the
  // server re-derives whether the song's timing still predates its audio.
  const retimingAfterReplace = useRef(new Set());
  const reloadProject = (projectId) => getMusicVideoProject(projectId, { silent: true }).then(replaceProject).catch(() => {});
  const lyricAlign = useMusicVideoLyricAlign({
    onAligned: (projectId, project) => {
      patchProject(projectId, { lyricCues: project.lyricCues, audioAnalysis: project.audioAnalysis, ...wordAnchoredShots(project), updatedAt: project.updatedAt });
      if (retimingAfterReplace.current.delete(projectId)) reloadProject(projectId);
    },
  });
  // A track attached or lyrics imported: analyze the song and align never-aligned
  // lines on the server, then follow the alignment here (the Song step shows it).
  const prepareSong = (projectId, { refresh = false } = {}) => {
    setAnalyzing(true);
    if (refresh) retimingAfterReplace.current.add(projectId);
    return prepareMusicVideoSong(projectId, { silent: true, ...(refresh ? { refresh } : {}) })
      .then(({ project, analyzed, alignJobId }) => {
        if (analyzed) patchProject(projectId, { audioAnalysis: project.audioAnalysis, updatedAt: project.updatedAt });
        if (alignJobId) lyricAlign.attach(alignJobId, projectId);
        // A re-analysis with nothing to re-time is done; the aligned callback covers the rest.
        else if (refresh) { retimingAfterReplace.current.delete(projectId); reloadProject(projectId); }
      })
      .catch((err) => toast.error(err?.message || 'Could not analyze the song'))
      .finally(() => setAnalyzing(false));
  };
  const midi = useMusicVideoMidiJob({
    onTranscribed: (projectId, midiTranscription) => patchProject(projectId, { midiTranscription, midiTranscriptionError: null }),
  });
  const renderJob = useMusicVideoRenderJob({
    project: selected,
    // A finished, cancelled or dropped render updates or resets the project's
    // status and renderDependencyState: ask the server to sync the full record (#9940).
    onSettled: (reason, projectId) => {
      if (reason === 'error') return;
      getMusicVideoProject(projectId, { silent: true }).then(replaceProject).catch(() => {});
    },
    onRendered: (projectId, result) => patchProject(projectId, (project) => ({
      renderHistoryId: result.id || project.renderHistoryId,
      status: 'complete', renderError: null,
    })),
    onFailed: (projectId, renderError) => patchProject(projectId, { status: 'failed', renderError }),
  });
  // Install-wide catalogs and posting state that outlive a project switch: the
  // video-gen model/LoRA catalog the pickers read, and the publish platforms
  // and history. Both hooks scope their per-project part by id themselves.
  const videoSettings = useMusicVideoModelSettings({ project: selected, onProjectPatch: patchProject });
  // Posting (#9282): fill each platform's post in the PortOS Browser, post on a second press.
  const publishing = useMusicVideoPublishing({ project: selected, replaceProject });

  // Resolves with the analyzed project, or null when analysis failed (toasted).
  const handleAnalyze = () => {
    if (!selected) return Promise.resolve(null);
    setAnalyzing(true);
    return analyzeMusicVideoProject(selected.id, { silent: true })
      .then((proj) => { replaceProject(proj); toast.success(`Analyzed — ${proj.audioAnalysis?.bpm ? `${proj.audioAnalysis.bpm} BPM` : 'no tempo detected'}`); return proj; })
      .catch((err) => { toast.error(err?.message || 'Analysis failed'); return null; })
      .finally(() => setAnalyzing(false));
  };

  // A reload (or another tab) leaves server jobs running that this page has no
  // slot for. Reattach alignment, vocal separation and MIDI so Setup shows them
  // running (#10155); each attach is a no-op while its slot is already busy.
  const reattachRef = useRef({});
  reattachRef.current = { lyricAlign, separation, midi };
  useEffect(() => {
    if (!selectedId) return undefined;
    let current = true;
    getMusicVideoActiveJobs(selectedId, { silent: true })
      .then(({ alignment, separation: separationJob, midi: midiJob }) => {
        if (!current) return;
        const slots = reattachRef.current;
        if (alignment) slots.lyricAlign.attach(alignment, selectedId);
        if (separationJob) slots.separation.attach(separationJob, selectedId);
        if (midiJob) slots.midi.attach(midiJob, selectedId);
      })
      .catch(() => {});
    return () => { current = false; };
  }, [selectedId]);

  // Project invalidations advertise jobs started after this tab opened.
  const activeMidiJob = selected?.activeMidiJob;
  useEffect(() => {
    if (activeMidiJob) reattachRef.current.midi.attach(activeMidiJob, selectedId);
  }, [activeMidiJob, selectedId]);

  return { youtube, separation, lyricAlign, midi, renderJob, videoSettings, publishing, analyzing, prepareSong, handleAnalyze };
}
