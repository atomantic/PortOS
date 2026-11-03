import { ExternalLink, X } from 'lucide-react';
import MediaImage from '../MediaImage';
import ResearchSeedForm from './ResearchSeedForm.jsx';
import { startMusicVideoSceneResearch } from '../../services/apiMusicVideo.js';
import { MUSIC_VIDEO_RESEARCH_REFERENCE_LIMIT } from '../../../../server/lib/musicVideoConditioning.js';

const hostOf = (url) => {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return null; }
};

/**
 * A shot's research photos (#14822): real photos of its subject a research
 * agent found, which lead its frame references. Each shows where it came from
 * and can be dropped.
 */
export default function SceneResearchSeed({ project, scene, onEditLocal, onSave, disabled = false }) {
  const refs = Array.isArray(scene.researchReferences) ? scene.researchReferences : [];
  const drop = (ref) => {
    const researchReferences = refs.filter((r) => r.id !== ref.id);
    const patch = { researchReferences, ...(Array.isArray(scene.frameReferenceIds) ? { frameReferenceIds: scene.frameReferenceIds.filter((id) => id !== ref.id) } : {}) };
    onEditLocal(scene.sceneId, patch);
    onSave(scene.sceneId, patch);
  };
  const applySaved = (saved) => {
    const next = saved?.scenes?.find((s) => s.sceneId === scene.sceneId);
    if (next) onEditLocal(scene.sceneId, { researchReferences: next.researchReferences, frameReferenceIds: next.frameReferenceIds ?? null });
  };

  return (
    <div role="group" aria-label="Research and seed" className="space-y-1">
      <span className="text-[11px] font-medium text-port-text">Research photos</span>
      {refs.length > 0 && (
        <ul aria-label="Research photos" className="grid grid-cols-2 gap-1 sm:grid-cols-3">
          {refs.map((ref) => {
            const host = hostOf(ref.pageUrl || ref.sourceUrl);
            return (
              <li key={ref.id} className="relative min-w-0 rounded border border-port-border bg-port-bg p-1">
                <MediaImage thumbnail src={`/data/images/${encodeURIComponent(ref.imageId)}`} alt={ref.subject} className="aspect-square w-full rounded bg-black object-cover" />
                <p className="mt-1 truncate text-[11px] text-port-text" title={ref.subject}>{ref.subject}</p>
                {host && (
                  <a href={ref.pageUrl || ref.sourceUrl} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-[32px] max-w-full items-center gap-1 truncate text-[11px] text-port-accent underline">
                    <ExternalLink size={10} aria-hidden="true" /><span className="truncate">{host}</span>
                  </a>
                )}
                <button type="button" onClick={() => drop(ref)} disabled={disabled} aria-label={`Drop research photo of ${ref.subject}`}
                  className="absolute right-1 top-1 inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded bg-black/60 text-white disabled:opacity-50 sm:min-h-[28px] sm:min-w-[28px]">
                  <X size={14} aria-hidden="true" />
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <ResearchSeedForm projectId={project.id} match={{ sceneId: scene.sceneId }} disabled={disabled}
        start={(body) => startMusicVideoSceneResearch(project.id, scene.sceneId, body, { silent: true })} onSaved={applySaved}
        room={MUSIC_VIDEO_RESEARCH_REFERENCE_LIMIT - refs.length} defaultSubject={refs.at(-1)?.subject || ''}
        intro="PortOS downloads them onto this shot, where they lead its references."
        limitNote={`This shot holds ${MUSIC_VIDEO_RESEARCH_REFERENCE_LIMIT} research photos. Drop one to research more.`} />
    </div>
  );
}
