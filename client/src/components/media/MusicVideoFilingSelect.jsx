import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';
import { listMusicVideoProjectSummaries } from '../../services/apiMusicVideo.js';
import { MUSIC_VIDEO_FILING_PARAM } from '../../lib/musicVideoFiling.js';

/**
 * "For music video" picker on the Image Gen and Video Gen forms: the render
 * also lands in the picked video's collection, with or without a shot. The
 * pick lives in the URL (`musicVideo`), set too by a handoff from one of the
 * video's clips, so the form sends what the picker shows.
 */
export default function MusicVideoFilingSelect({ id = 'media-gen-music-video', disabled = false }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const value = searchParams.get(MUSIC_VIDEO_FILING_PARAM) || '';
  const [projects, setProjects] = useState([]);
  useEffect(() => {
    let active = true;
    listMusicVideoProjectSummaries({ limit: 100 }, { silent: true })
      .then((page) => { if (active) setProjects(page?.items || []); })
      .catch(() => {});
    return () => { active = false; };
  }, []);
  const pick = (projectId) => setSearchParams((previous) => {
    const next = new URLSearchParams(previous);
    if (projectId) next.set(MUSIC_VIDEO_FILING_PARAM, projectId);
    else next.delete(MUSIC_VIDEO_FILING_PARAM);
    return next;
  }, { replace: true });
  if (!value && projects.length === 0) return null;
  const listed = projects.some((project) => project.id === value);
  return (
    <div className="flex min-w-0 items-center gap-2">
      <label htmlFor={id} className="shrink-0 text-xs text-gray-400">Music video <span className="text-gray-500">(Optional)</span></label>
      <select id={id} value={value} onChange={(e) => pick(e.target.value)} disabled={disabled}
        title="Also keep this render in the music video's collection"
        className="min-w-0 flex-1 bg-port-bg border border-port-border rounded px-2 py-1 text-sm min-h-[44px] sm:min-h-0">
        <option value="">None</option>
        {value && !listed && <option value={value}>This music video</option>}
        {projects.map((project) => <option key={project.id} value={project.id}>{project.name || 'Untitled'}</option>)}
      </select>
    </div>
  );
}
