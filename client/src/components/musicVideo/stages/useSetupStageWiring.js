import { useState } from 'react';
import toast from '../../ui/Toast';
import {
  cloneMusicVideoProject,
  importMusicVideoLyrics,
  importMusicVideoTrackLyrics,
  updateMusicVideoProject,
} from '../../../services/apiMusicVideo.js';
import { trackAudioUrl } from '../../../services/apiTracks.js';
import useMusicVideoManualTempo from './useMusicVideoManualTempo.js';

/**
 * Song step (Setup): the track link, manual tempo, lyric import and word
 * alignment. The alignment, MIDI and render slots are page-wide (they outlive a
 * project switch); this binds them to the open project by id.
 */
export default function useSetupStageWiring({
  selected, tracks, midi, lyricAlign, renderTargetsSelected, replaceProject, openProject, prepareSong, navigate, onClone, saveOwnEdit,
}) {
  const [importingLyrics, setImportingLyrics] = useState(false);
  const tempo = useMusicVideoManualTempo({ project: selected, onUpdated: replaceProject });
  // `midiTargetsSelected` gates the track-change controls, since the .mid being
  // produced is of the CURRENT audio (mirrors renderTargetsSelected).
  const midiTargetsSelected = Boolean(selected?.activeMidiJob || (midi.active && selected && midi.context === selected.id));

  // Re-point the selected project at a different library track (the detail
  // view's "Change track" picker — previously there was no way to relink a
  // project's audio after creation at all).
  const handleChangeTrack = (trackId, { fork = false } = {}) => {
    if (!selected) return;
    // Preparation is already resolving the project's audio at kickoff;
    // relinking the track now would leave the project pointing at a NEW track
    // while the video that finishes rendering was produced from the OLD one.
    if (renderTargetsSelected) {
      toast.error('Wait for the current render to finish before changing the track');
      return;
    }
    const selectedTrack = tracks.find((t) => t.id === trackId);
    const patch = { trackId };
    if (selectedTrack?.concept && !selected.concept?.prompt) {
      patch.concept = { ...(selected.concept || {}), prompt: selectedTrack.concept };
    }
    // The track's Suno style becomes the project's song style on the server.
    // Fork first so the original keeps its analysis/alignment; the new track is
    // applied to the fork only.
    const base = fork
      ? cloneMusicVideoProject(selected.id, {}, { silent: true })
      : Promise.resolve(selected);
    base
      .then((target) => updateMusicVideoProject(target.id, patch, { silent: true }).then((proj) => ({ proj, forked: target !== selected })))
      .then(({ proj, forked }) => {
        if (forked) {
          openProject(proj);
          navigate(`/music-video/${proj.id}/setup`);
        } else replaceProject(proj);
        prepareSong(proj.id);
      })
      .catch((err) => toast.error(err?.message || 'Failed to change track'));
  };

  const handleImportLyrics = (body, onDone) => {
    const projectId = selected.id;
    setImportingLyrics(true);
    saveOwnEdit(projectId, (options) => importMusicVideoLyrics(projectId, body, options))
      .then(({ imported, format }) => {
        onDone?.();
        toast.success(`Imported ${imported} lyric line${imported === 1 ? '' : 's'} (${format})`);
        prepareSong(projectId);
      })
      .catch((err) => toast.error(err?.message || 'Lyric import failed'))
      .finally(() => setImportingLyrics(false));
  };
  // "Use track lyrics": replace the lines with the linked track's sheet.
  const handleImportTrackLyrics = () => {
    const projectId = selected.id;
    setImportingLyrics(true);
    saveOwnEdit(projectId, (options) => importMusicVideoTrackLyrics(projectId, { mode: 'replace' }, options))
      .then(({ imported, markers }) => {
        toast.success(`Imported ${imported} lyric line${imported === 1 ? '' : 's'}${markers ? ` and ${markers} section/direction marker${markers === 1 ? '' : 's'}` : ''} from the track`);
        prepareSong(projectId);
      })
      .catch((err) => toast.error(err?.message || 'Could not import the track lyrics'))
      .finally(() => setImportingLyrics(false));
  };
  // A re-align is a click (imports align through prepareSong). The panel shows
  // the alignment setup error itself, so this request stays silent.
  const handleAlignLyrics = (cueId, options) => lyricAlign.run(selected.id, cueId, options);
  // Revise song: open the new version on its Song step and follow its re-time job there.
  const handleSongRevised = ({ project, retimeJobId }) => {
    openProject(project);
    navigate(`/music-video/${project.id}/setup`);
    if (retimeJobId) lyricAlign.attach(retimeJobId, project.id);
    toast.success(`Created ${project.name} with the new song`);
  };
  const handleRetimeSong = () => lyricAlign.run(selected.id, null, { retimeSong: true })
    .catch((err) => toast.error(err?.message || 'Could not re-time to the new song'));
  // The slot is page-wide but the job belongs to one project: only that
  // project's Setup shows "Aligning…".
  const aligningLyrics = Boolean(lyricAlign.active && selected && lyricAlign.context?.projectId === selected.id);
  const alignStatus = aligningLyrics ? { label: lyricAlign.stageLabel, percent: lyricAlign.percent, onCancel: lyricAlign.cancel } : null;

  // The project's master audio file lives under data/music/ — either the linked
  // track's stored audio or the project's own uploaded file: the bare basename
  // (or null when the project has no audio yet) for the preview/download
  // controls; the bytes are served statically via trackAudioUrl().
  const audioFilename = selected.trackId
    ? tracks.find((t) => t.id === selected.trackId)?.audioFilename || null
    : selected.uploadedAudioFilename || null;
  const audioUrl = audioFilename ? trackAudioUrl(audioFilename) : null;

  return {
    audioUrl,
    // The board keys the Song step reads.
    board: {
      onForkSong: () => onClone({}, {}, true),
      audioFilename,
      audioUrl,
      midiBound: midiTargetsSelected,
      tempo,
      importingLyrics,
      aligningLyrics,
      alignStatus,
      onChangeTrack: handleChangeTrack,
      onImportLyrics: handleImportLyrics,
      onImportTrackLyrics: handleImportTrackLyrics,
      onAlignLyrics: handleAlignLyrics,
      onSongRevised: handleSongRevised,
      onRetimeSong: handleRetimeSong,
      retimeStatus: alignStatus,
    },
  };
}
