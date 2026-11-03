import { useEffect, useRef, useState } from 'react';
import { ExternalLink, Search, X } from 'lucide-react';
import ProviderModelSelector from '../ProviderModelSelector.jsx';
import SentPromptPanel from '../media/SentPromptPanel.jsx';
import MediaImage from '../MediaImage';
import useProviderModels from '../../hooks/useProviderModels.js';
import socket from '../../services/socket';
import { startMusicVideoSceneResearch } from '../../services/apiMusicVideo.js';
import { MUSIC_VIDEO_RESEARCH_REFERENCE_LIMIT } from '../../../../server/lib/musicVideoConditioning.js';

const BUTTON = 'inline-flex min-h-[44px] items-center gap-1 rounded border border-port-border px-3 py-1.5 text-sm disabled:opacity-50 sm:min-h-0';
const COUNTS = [1, 2, 3, 4];
const hostOf = (url) => {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return null; }
};

/**
 * Research and seed (#14822): a research agent the director picks finds real
 * photos of the shot's subject and PortOS imports them onto the shot, where
 * they lead the frame references. Each photo shows where it came from and can
 * be dropped. The run finishes in the background; its result arrives as a
 * `music-video:scene-research` event carrying the saved project.
 */
export default function SceneResearchSeed({ project, scene, onEditLocal, onSave, disabled = false }) {
  const refs = Array.isArray(scene.researchReferences) ? scene.researchReferences : [];
  const [open, setOpen] = useState(false);
  const [subject, setSubject] = useState(() => refs.at(-1)?.subject || '');
  const [count, setCount] = useState(3);
  const llm = useProviderModels({ withEffort: true, silent: true, enabled: open });
  const [effort, setEffort] = useState('');
  const [executionOptions, setExecutionOptions] = useState({});
  const [status, setStatus] = useState(null); // null | 'running' | { error } | { added }
  const [sent, setSent] = useState(null);
  const flight = useRef(false);
  const room = MUSIC_VIDEO_RESEARCH_REFERENCE_LIMIT - refs.length;
  // Only an agent CLI can search the web; a direct API model would guess photo URLs.
  const searchProviders = (llm.providers || []).filter((p) => p?.type !== 'api');
  const apiPicked = (llm.providers || []).find((p) => p?.id === llm.selectedProviderId)?.type === 'api';
  const providerId = apiPicked ? '' : llm.selectedProviderId;
  const fieldId = `mv-research-${scene.sceneId}`;

  useEffect(() => {
    const receive = (event) => {
      if (event?.projectId !== project.id || event?.sceneId !== scene.sceneId) return;
      if (event.status === 'running') { setStatus('running'); return; }
      if (event.status === 'failed') { setStatus({ error: event.error || 'Research found no usable photos.' }); return; }
      const saved = event.project?.scenes?.find((s) => s.sceneId === scene.sceneId);
      if (saved) onEditLocal(scene.sceneId, { researchReferences: saved.researchReferences, frameReferenceIds: saved.frameReferenceIds ?? null });
      setStatus({ added: event.added || 0 });
    };
    socket.on('music-video:scene-research', receive);
    return () => socket.off('music-video:scene-research', receive);
  }, [project.id, scene.sceneId, onEditLocal]);

  const run = async (preview = false) => {
    if (flight.current || disabled || subject.trim().length < 2 || !providerId) return;
    flight.current = true;
    if (!preview) setStatus('running');
    const result = await startMusicVideoSceneResearch(project.id, scene.sceneId, {
      subject: subject.trim(), count: Math.min(count, Math.max(room, 1)), providerId,
      model: llm.selectedModel || undefined, effort: effort || undefined, executionOptions, preview,
    }, { silent: true }).catch((err) => { setStatus(preview ? null : { error: err?.message || 'Could not start research.' }); return null; });
    flight.current = false;
    if (result) setSent({ prompt: subject.trim(), sentPrompt: result.sentPrompt, additions: result.promptAdditions || [] });
  };

  const drop = (ref) => {
    const researchReferences = refs.filter((r) => r.id !== ref.id);
    const patch = { researchReferences, ...(Array.isArray(scene.frameReferenceIds) ? { frameReferenceIds: scene.frameReferenceIds.filter((id) => id !== ref.id) } : {}) };
    onEditLocal(scene.sceneId, patch);
    onSave(scene.sceneId, patch);
  };

  const running = status === 'running';
  return (
    <div role="group" aria-label="Research and seed" className="space-y-1">
      <div className="flex flex-wrap items-center gap-2 text-[11px] text-port-text-muted">
        <span className="font-medium text-port-text">Research photos</span>
        {!open && (
          <button type="button" onClick={() => setOpen(true)} disabled={disabled} className="inline-flex min-h-[44px] items-center gap-1 underline sm:min-h-0">
            <Search size={12} aria-hidden="true" /> Research and seed
          </button>
        )}
        {running && <span role="status">Searching for photos…</span>}
      </div>
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
      {open && (
        <section aria-label="Research and seed settings" className="space-y-2 rounded border border-port-border p-2">
          <p className="text-xs text-port-text-muted">An agent CLI that can search the web (Claude Code, Codex, Gemini, Grok) looks for real photos of the subject; PortOS downloads them onto this shot, where they lead its references. Each keeps a link to where it came from.</p>
          <label htmlFor={`${fieldId}-subject`} className="block text-xs text-port-text-muted">Subject
            <input id={`${fieldId}-subject`} value={subject} maxLength={200} onChange={(e) => setSubject(e.target.value)} disabled={running}
              placeholder="For example: Bernedoodle (Bernese Mountain Dog × Poodle), adult"
              className="w-full min-w-0 rounded border border-port-border bg-port-bg px-2 py-1.5 text-sm" />
          </label>
          <label htmlFor={`${fieldId}-count`} className="block text-xs text-port-text-muted">Photos
            <select id={`${fieldId}-count`} value={count} onChange={(e) => setCount(Number(e.target.value))} disabled={running}
              className="ml-2 min-h-[44px] rounded border border-port-border bg-port-bg px-2 text-sm sm:min-h-0">
              {COUNTS.map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </label>
          <ProviderModelSelector providers={searchProviders} emptyProviderOption="Pick an agent that can search the web" selectedProviderId={providerId} selectedModel={llm.selectedModel}
            availableModels={llm.availableModels} onProviderChange={(id) => { llm.setSelectedProviderId(id); setEffort(''); setExecutionOptions({}); }} onModelChange={llm.setSelectedModel}
            effort={effort} onEffortChange={setEffort} executionOptions={executionOptions} onExecutionOptionsChange={setExecutionOptions}
            loading={llm.loading} disabled={running || disabled} />
          <div className="flex flex-wrap gap-2">
            <button type="button" className={BUTTON} disabled={running || disabled || room < 1 || subject.trim().length < 2 || !providerId} onClick={() => run()}>
              <Search size={14} aria-hidden="true" /> {running ? 'Researching…' : 'Find photos'}
            </button>
            <button type="button" className={BUTTON} disabled={running || disabled || subject.trim().length < 2 || !providerId} onClick={() => run(true)}>Preview prompt</button>
            <button type="button" className={BUTTON} onClick={() => setOpen(false)}>Close</button>
          </div>
          {room < 1 && <p className="text-xs text-port-text-muted">This shot holds {MUSIC_VIDEO_RESEARCH_REFERENCE_LIMIT} research photos. Drop one to research more.</p>}
          {sent && <SentPromptPanel {...sent} />}
        </section>
      )}
      {status?.error && <p role="alert" className="text-xs text-port-error">{status.error}</p>}
      {status?.added > 0 && <p role="status" className="text-xs text-port-text-muted">Added {status.added} photo{status.added === 1 ? '' : 's'}. Drop any that look wrong before rendering.</p>}
    </div>
  );
}
