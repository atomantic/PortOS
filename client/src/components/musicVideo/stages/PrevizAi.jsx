import { useState } from 'react';
import { Sparkles } from 'lucide-react';
import ProviderModelSelector from '../../ProviderModelSelector.jsx';
import SentPromptPanel from '../../media/SentPromptPanel.jsx';
import WorldMap, { fitWorldView } from '../../catalog/WorldMapView';
import useProviderModels from '../../../hooks/useProviderModels.js';
import { proposeMusicVideoPrevizEdit } from '../../../services/apiMusicVideo.js';
import { saveCatalogWorld } from '../../../services/apiCatalog.js';
import { formatCount } from '../../../utils/formatters.js';
import { worldClockText } from '../../../../../server/lib/worldMap.js';

const buttonCls = 'inline-flex min-h-[44px] items-center gap-1 rounded border border-port-border px-2 py-1 text-xs disabled:opacity-50 pointer-fine:sm:min-h-0';
const inputCls = 'w-full min-w-0 rounded border border-port-border bg-port-bg px-1.5 py-1 text-xs';
const PART_ORDER = ['world', 'timeline', 'vehicles', 'cuts', 'pawnColors', 'cameraStyles'];
const plural = (n, word) => `${formatCount(n)} ${word}${n === 1 ? '' : 's'}`;

const cutLine = (patch, nameOf, numberOf) => {
  const bits = [];
  if ('placeSubjectId' in patch) bits.push(`set ${nameOf(patch.placeSubjectId) || 'none'}`);
  if ('holderSubjectId' in patch) bits.push(patch.holderSubjectId ? `held by ${nameOf(patch.holderSubjectId)}` : 'observer camera');
  if ('aimSubjectId' in patch) bits.push(patch.aimSubjectId ? `keeps ${nameOf(patch.aimSubjectId)} in frame` : 'camera\'s own aim');
  if ('selfie' in patch) bits.push(patch.selfie ? 'selfie' : 'no selfie');
  if ('turnToAim' in patch) bits.push(patch.turnToAim ? 'turns to them' : 'no turn');
  if ('visibleSubjectIds' in patch) bits.push(patch.visibleSubjectIds ? `shows ${patch.visibleSubjectIds.map(nameOf).join(', ') || 'nobody'}` : 'shows everyone');
  if ('storyMin' in patch) bits.push(patch.storyMin == null ? 'off the timeline' : `story minute ${formatCount(Math.round(patch.storyMin))}`);
  if ('cameraSpot' in patch) bits.push(patch.cameraSpot ? `camera at ${patch.cameraSpot.map((v) => Math.round(v)).join(', ')} m` : 'auto camera spot');
  return `${numberOf(patch.id)}: ${bits.join(' · ')}`;
};

/**
 * Edit the previz by asking a model: the director writes what to change and
 * picks provider › model › effort, and the model's world map, timeline, cut edits,
 * pawn colors and camera styles come back as a proposal to review. Each part is
 * applied (or not) on its own; nothing is saved until Apply.
 */
export default function PrevizAi({ project, world, worldId, places, previz, disabled, onSavePreviz, onSaveCameras }) {
  const llm = useProviderModels({ withEffort: true, silent: true });
  const [effort, setEffort] = useState('');
  const [executionOptions, setExecutionOptions] = useState({});
  const [instruction, setInstruction] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [sent, setSent] = useState(null);
  const [review, setReview] = useState(null);
  const subjects = project.concept?.subjects || [];
  const nameOf = (id) => subjects.find((subject) => subject.id === id)?.name || id;
  const numberOf = (cutId) => {
    const cut = (previz?.cuts || []).find((entry) => entry.id === cutId);
    const at = cut?.sceneId ? (project.scenes || []).findIndex((scene) => scene.sceneId === cut.sceneId) : -1;
    return at >= 0 ? `Shot ${at + 1}` : 'Cut';
  };

  const ask = async (preview) => {
    setBusy(true); setError('');
    if (!preview) setReview(null);
    const result = await proposeMusicVideoPrevizEdit(project.id, {
      providerId: llm.selectedProviderId, model: llm.selectedModel || undefined, effort: effort || undefined, executionOptions,
      instruction: instruction.trim(), ...(preview ? { preview: true } : {}),
    }, { silent: true }).catch((err) => { setError(err?.message || 'The provider failed.'); return null; });
    setBusy(false);
    if (!result) return;
    setSent({ prompt: instruction, sentPrompt: result.sentPrompt, additions: result.promptAdditions });
    if (preview) return;
    const parts = PART_ORDER.filter((key) => result.proposal[key] !== undefined);
    setReview({ ...result, keep: Object.fromEntries(parts.map((key) => [key, true])) });
  };

  const apply = async () => {
    const { proposal, keep } = review;
    setBusy(true); setError('');
    if (keep.world && proposal.world) {
      const saved = await saveCatalogWorld(worldId, proposal.world, { source: 'refine', silent: true }).catch((err) => { setError(err?.message || 'The world map could not be saved.'); return null; });
      if (!saved) { setBusy(false); return; }
    }
    const patch = {};
    if (keep.timeline && proposal.timeline) patch.timeline = proposal.timeline;
    if (keep.vehicles && proposal.vehicles) patch.vehicles = proposal.vehicles;
    if (keep.pawnColors && proposal.pawnColors) patch.pawnColors = { ...(previz?.pawnColors || {}), ...proposal.pawnColors };
    if (keep.cuts && proposal.cuts && previz?.cuts) {
      const edits = new Map(proposal.cuts.map(({ id, ...edit }) => [id, edit]));
      patch.cuts = previz.cuts.map((cut) => (edits.has(cut.id) ? { ...cut, ...edits.get(cut.id) } : cut));
    }
    if (Object.keys(patch).length) onSavePreviz(patch);
    if (keep.cameraStyles && proposal.cameraStyles) {
      onSaveCameras((project.cameras || []).map((camera) => (proposal.cameraStyles[camera.id] ? { ...camera, previzStyle: proposal.cameraStyles[camera.id] } : camera)));
    }
    setBusy(false);
    setReview(null);
  };

  const toggle = (key) => setReview((current) => ({ ...current, keep: { ...current.keep, [key]: !current.keep[key] } }));
  const kept = review ? PART_ORDER.filter((key) => review.keep[key]).length : 0;
  const parts = review ? PART_ORDER.filter((key) => review.proposal[key] !== undefined) : [];
  const { proposal } = review || {};
  const describe = {
    world: () => `${plural(proposal.world.sets.length, 'set')}, ${plural(proposal.world.paths.length, 'path')} (now ${plural(world?.sets.length || 0, 'set')}, ${plural(world?.paths.length || 0, 'path')})`,
    timeline: () => `${plural(proposal.timeline.beats.length, 'beat')}, from ${worldClockText(proposal.timeline.startClock)} for ${formatCount(Math.round(proposal.timeline.lengthMin / 6) / 10)} h`,
    vehicles: () => proposal.vehicles.map((vehicle) => `${nameOf(vehicle.subjectId)}: ${formatCount(vehicle.speedMetersPerMin)} m/min`).join(' · ') || 'none',
    cuts: () => plural(proposal.cuts.length, 'cut edit'),
    pawnColors: () => Object.entries(proposal.pawnColors).map(([id, colors]) => `${nameOf(id)}: ${colors.figure}`).join(' · '),
    cameraStyles: () => Object.entries(proposal.cameraStyles).map(([id, style]) => `${(project.cameras || []).find((camera) => camera.id === id)?.name || id}: ${style}`).join(' · '),
  };
  const LABELS = { world: 'World map', timeline: 'Timeline', vehicles: 'Vehicles', cuts: 'Cuts', pawnColors: 'Pawn colors', cameraStyles: 'Camera styles' };
  return (
    <section aria-label="Edit the previz with AI" className="min-w-0 space-y-2 rounded border border-port-border p-2 text-xs">
      <ProviderModelSelector providers={llm.providers} selectedProviderId={llm.selectedProviderId} selectedModel={llm.selectedModel}
        availableModels={llm.availableModels} onProviderChange={(id) => { llm.setSelectedProviderId(id); setEffort(''); setExecutionOptions({}); }} onModelChange={llm.setSelectedModel}
        effort={effort} onEffortChange={setEffort} executionOptions={executionOptions} onExecutionOptionsChange={setExecutionOptions}
        loading={llm.loading} disabled={busy || disabled} />
      <textarea aria-label="What to change in the previz" rows={3} maxLength={4000} value={instruction} onChange={(event) => setInstruction(event.target.value)}
        placeholder="e.g. Put the station at the far east end of the main road, and in shot 1 have the friend walk on the lead's right while the lead turns the camera to them" className={inputCls} />
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className={buttonCls} disabled={busy || disabled || !llm.selectedProviderId || !instruction.trim()} onClick={() => ask(false)}>
          <Sparkles size={12} aria-hidden="true" /> {busy ? 'Asking…' : 'Propose changes'}
        </button>
        <button type="button" className={buttonCls} disabled={busy || !llm.selectedProviderId || !instruction.trim()} onClick={() => ask(true)}>Show full prompt</button>
        <span className="text-port-text-muted">Nothing saves until you review it and press Apply.</span>
      </div>
      {error && <p role="alert" className="text-port-error">{error}</p>}
      {sent && <SentPromptPanel {...sent} />}
      {review && (
        <div className="min-w-0 space-y-2">
          {review.summary && <p className="text-port-text">{review.summary}</p>}
          {review.dropped?.length > 0 && <p role="status" className="text-port-warning">Left out: {review.dropped.join(' · ')}</p>}
          {!parts.length && <p className="text-port-text-muted">The model proposed no usable change.</p>}
          <ul className="min-w-0 space-y-1.5">
            {parts.map((key) => (
              <li key={key} className="min-w-0 space-y-1">
                <label className="flex min-h-[44px] items-center gap-1 font-medium pointer-fine:sm:min-h-0">
                  <input type="checkbox" checked={!!review.keep[key]} disabled={busy} onChange={() => toggle(key)} aria-label={`Apply ${LABELS[key]}`} />
                  {LABELS[key]}: <span className="font-normal text-port-text-muted">{describe[key]()}</span>
                </label>
                {key === 'cuts' && (
                  <ul className="max-h-48 overflow-y-auto pl-5 text-port-text-muted">
                    {proposal.cuts.map((patch) => <li key={patch.id}>{cutLine(patch, nameOf, numberOf)}</li>)}
                  </ul>
                )}
                {key === 'world' && (
                  <div className="max-w-sm"><WorldMap world={proposal.world} places={places} view={fitWorldView(proposal.world)} onView={() => {}} /></div>
                )}
              </li>
            ))}
          </ul>
          {parts.length > 0 && (
            <div className="flex flex-wrap gap-2">
              <button type="button" className={buttonCls} disabled={busy || disabled || !kept} onClick={apply}>Apply {plural(kept, 'part')}</button>
              <button type="button" className={buttonCls} disabled={busy} onClick={() => setReview(null)}>Discard</button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
