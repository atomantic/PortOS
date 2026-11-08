import { useRef, useState } from 'react';
import ProviderModelSelector from '../ProviderModelSelector.jsx';
import SentPromptPanel from '../media/SentPromptPanel.jsx';
import useProviderModels from '../../hooks/useProviderModels.js';
import { proposeMusicVideoShotSheet } from '../../services/apiMusicVideo.js';
import { SHOT_SHEET_PROPOSE_BATCH, mergeShotSheetBackfill, normalizeShotSheet, shotSheetDrivesPrompt } from '../../../../server/lib/musicVideoShotSheet.js';

const button = 'min-h-[44px] rounded border border-port-border px-2 py-1 text-xs disabled:opacity-50 pointer-fine:sm:min-h-0';
const input = 'w-full min-w-0 rounded border border-port-border bg-port-bg px-1.5 py-1 text-xs';
const FIELD_LABELS = { cameraId: 'Camera', holder: 'Held by', view: 'View', location: 'Location', timeOfDay: 'Time of day', light: 'Light', characters: 'Who', action: 'Action', emotion: 'Emotion', notes: 'Notes' };

const chunks = (items, size) => Array.from({ length: Math.ceil(items.length / size) }, (_, at) => items.slice(at * size, (at + 1) * size));

/** One proposed backfill: only the columns still empty on the shot as it is now. */
function BackfillReview({ item, scene, cameras, quiet = false }) {
  const { filled } = mergeShotSheetBackfill(scene?.shotSheet || {}, item.proposedSheet);
  if (!filled.length && quiet) return null;
  if (!filled.length) return <p className="text-xs text-port-text-muted">You have filled these columns since, so this shot has nothing left to change.</p>;
  const show = (field, value) => (field === 'cameraId' ? cameras.find((camera) => camera.id === value)?.name || value : Array.isArray(value) ? value.join(', ') : value);
  return (
    <dl className="grid grid-cols-[6rem_minmax(0,1fr)] gap-x-2 text-xs">
      {filled.map((field) => (
        <div key={field} className="contents"><dt className="text-port-text-muted">{FIELD_LABELS[field] || field}</dt><dd className="break-words">{show(field, item.proposedSheet[field])}</dd></div>
      ))}
    </dl>
  );
}

/** One proposed split: the columns it fills, and the frame prompt beside the general prompt that is left, editable. */
function SplitReview({ item, scene, cameras, disabled, onEdit }) {
  return (
    <div className="min-w-0 space-y-2">
      <BackfillReview item={item} scene={scene} cameras={cameras} quiet />
      <div className="grid min-w-0 gap-2 text-xs sm:grid-cols-2">
        <div className="min-w-0"><p className="font-medium">Frame prompt now</p><p className="max-h-48 overflow-y-auto whitespace-pre-wrap break-words text-port-text-muted">{scene?.framePrompt || 'None'}</p></div>
        <label className="block min-w-0"><span className="font-medium">General prompt proposed</span>
          <textarea aria-label={`${item.label} General prompt proposed`} rows={6} maxLength={8000} value={item.generalPrompt} disabled={disabled} onChange={(event) => onEdit(event.target.value)} className={input} />
        </label>
      </div>
    </div>
  );
}

/** One proposed rewrite: current text beside an editable proposal, so the director has the last word. */
function PromptReview({ item, scene, disabled, onEdit }) {
  const name = 'Shot prompt';
  // A legacy shot's separate frame prompt leads its one prompt; a sheet-built still keeps its own.
  const now = shotSheetDrivesPrompt(scene) ? scene?.prompt : [scene?.framePrompt, scene?.prompt].filter(Boolean).join(' ');
  return (
    <div className="grid min-w-0 gap-2 text-xs sm:grid-cols-2">
      <div className="min-w-0"><p className="font-medium">{name} now</p><p className="max-h-48 overflow-y-auto whitespace-pre-wrap break-words text-port-text-muted">{now || 'None'}</p></div>
      <label className="block min-w-0"><span className="font-medium">{name} proposed</span>
        <textarea aria-label={`${item.label} ${name} proposed`} rows={6} maxLength={8000} value={item.proposed.prompt} disabled={disabled} onChange={(event) => onEdit('prompt', event.target.value)} className={input} />
      </label>
    </div>
  );
}

/**
 * AI help for the shot sheet, only on request: fill a shot's empty columns from
 * its existing prompts, write its prompts from the sheet you edited, or split a
 * long frame prompt into columns and a general prompt so the still is built from the sheet, or
 * tighten long prompts that say things twice into one short prompt. Works on the shots currently listed. Every result is a proposal you
 * review, edit and select; nothing is saved until Apply, and Done is yours alone.
 */
export default function ShotSheetAi({ project, rows, disabled, onApply, onApplyingChange }) {
  const llm = useProviderModels({ withEffort: true, silent: true });
  const [effort, setEffort] = useState('');
  const [executionOptions, setExecutionOptions] = useState({});
  const [instruction, setInstruction] = useState('');
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState('');
  const [error, setError] = useState('');
  const [sent, setSent] = useState(null);
  const [review, setReview] = useState(null);
  const [applying, setApplying] = useState(false);
  const stop = useRef(false);
  // A proposal outlives the render that asked for it, and an applied shot can leave `rows` through
  // a filter, so every merge reads the shot as it is now from the whole project.
  const latestProject = useRef(project);
  latestProject.current = project;
  const sceneNow = (sceneId) => latestProject.current.scenes?.find((scene) => scene.sceneId === sceneId);

  const backfillRows = rows.filter((row) => !row.sheet.checked);
  const promptRows = rows.filter((row) => row.sheet.checked);
  // Shots still rendering from a hand-written frame prompt, which a split moves onto their sheet.
  const splitRows = rows.filter((row) => !shotSheetDrivesPrompt(row.scene) && row.scene.framePrompt?.trim());
  // Any listed shot can be tightened: its prompt may be long whether or not its sheet is done.
  const tightenRows = rows.filter((row) => row.scene.prompt?.trim() || row.scene.framePrompt?.trim());
  const targets = (direction) => ({ split: splitRows, 'from-prompts': backfillRows, tighten: tightenRows }[direction] || promptRows);

  const request = (direction, sceneIds, preview = false) => proposeMusicVideoShotSheet(project.id, {
    providerId: llm.selectedProviderId, model: llm.selectedModel || undefined, effort: effort || undefined, executionOptions,
    direction, sceneIds, ...(instruction.trim() ? { instruction: instruction.trim() } : {}), ...(preview ? { preview: true } : {}),
  }, { silent: true });

  const preview = async (direction) => {
    setBusy(true); setError('');
    const result = await request(direction, targets(direction).slice(0, SHOT_SHEET_PROPOSE_BATCH).map((row) => row.scene.sceneId), true)
      .catch((err) => { setError(err?.message || 'Could not build the prompt.'); return null; });
    setBusy(false);
    if (result) setSent({ prompt: instruction, sentPrompt: result.sentPrompt, additions: result.promptAdditions });
  };

  const run = async (direction) => {
    const target = targets(direction);
    const byId = new Map(target.map((row) => [row.scene.sceneId, row]));
    const batches = chunks(target, SHOT_SHEET_PROPOSE_BATCH);
    let proposals = 0;
    stop.current = false;
    setBusy(true); setError(''); setReview(null);
    for (let at = 0; at < batches.length && !stop.current; at += 1) {
      setProgress(`Batch ${at + 1} of ${batches.length}`);
      const result = await request(direction, batches[at].map((row) => row.scene.sceneId)).catch((err) => { setError(err?.message || 'The provider failed.'); return null; });
      if (!result) break; // Whatever came back from earlier batches stays reviewable.
      setSent({ prompt: instruction, sentPrompt: result.sentPrompt, additions: result.promptAdditions });
      const items = [];
      for (const shot of result.shots) {
        const { label } = byId.get(shot.sceneId).scene;
        if (direction === 'split') {
          items.push({ sceneId: shot.sceneId, label, selected: true, proposedSheet: shot.sheet, generalPrompt: shot.generalPrompt });
        } else if (direction === 'from-prompts') {
          if (mergeShotSheetBackfill(sceneNow(shot.sceneId)?.shotSheet || {}, shot.sheet).filled.length) items.push({ sceneId: shot.sceneId, label, selected: true, proposedSheet: shot.sheet });
        } else {
          const { sceneId: _sceneId, ...proposed } = shot;
          items.push({ sceneId: shot.sceneId, label, selected: true, proposed });
        }
      }
      proposals += items.length;
      // Appended to the live review: the director may be editing an earlier batch while this one runs.
      setReview((current) => ({ direction, items: [...(current?.items || []), ...items] }));
    }
    setProgress(''); setBusy(false);
    if (!proposals) setReview({ direction, items: [] });
  };

  const change = (sceneId, update) => setReview((current) => ({ ...current, items: current.items.map((item) => (item.sceneId === sceneId ? update(item) : item)) }));

  const patchFor = (item, scene) => {
    if (review.direction === 'split') {
      // Applying a split is what switches the shot to building its still from the sheet.
      const { sheet } = mergeShotSheetBackfill(scene.shotSheet || {}, item.proposedSheet);
      return { shotSheet: normalizeShotSheet({ ...sheet, promptFromSheet: true }), framePrompt: item.generalPrompt.trim() || null };
    }
    // One shot prompt: it replaces a legacy separate frame prompt, except where the sheet builds the still.
    if (review.direction !== 'from-prompts') return shotSheetDrivesPrompt(scene) ? item.proposed : { ...item.proposed, framePrompt: null };
    const { sheet, filled } = mergeShotSheetBackfill(scene.shotSheet || {}, item.proposedSheet);
    return filled.length ? { shotSheet: normalizeShotSheet(sheet) } : null;
  };

  const apply = async () => {
    setBusy(true); setApplying(true); onApplyingChange?.(true);
    const left = [];
    for (const item of review.items) {
      if (!item.selected) { left.push(item); continue; }
      const scene = sceneNow(item.sceneId);
      const patch = scene && patchFor(item, scene);
      // A deleted shot, or one whose columns the director has since filled, has nothing to save.
      if (patch && !await onApply(item.sceneId, patch)) left.push(item);
    }
    setBusy(false); setApplying(false); onApplyingChange?.(false);
    setReview(left.length ? { ...review, items: left } : null);
  };

  const selectedCount = review?.items.filter((item) => item.selected).length || 0;
  const noProvider = !llm.selectedProviderId;
  return (
    <section aria-label="AI help" className="min-w-0 space-y-2 rounded border border-port-border p-2">
      <p className="text-xs text-port-text-muted">Works on the shots listed below. Nothing saves until you review it and press Apply, and AI never ticks Done.</p>
      <ProviderModelSelector providers={llm.providers} selectedProviderId={llm.selectedProviderId} selectedModel={llm.selectedModel}
        availableModels={llm.availableModels} onProviderChange={(id) => { llm.setSelectedProviderId(id); setEffort(''); setExecutionOptions({}); }} onModelChange={llm.setSelectedModel}
        effort={effort} onEffortChange={setEffort} executionOptions={executionOptions} onExecutionOptionsChange={setExecutionOptions}
        loading={llm.loading} disabled={busy || disabled} />
      <textarea aria-label="Note for the AI" rows={2} maxLength={4000} value={instruction} onChange={(event) => setInstruction(event.target.value)} placeholder="Optional note for the AI" className={input} />
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className={button} disabled={busy || disabled || noProvider || !backfillRows.length} onClick={() => run('from-prompts')}>
          Fill empty columns from prompts ({backfillRows.length} not done)
        </button>
        <button type="button" className={button} disabled={busy || disabled || noProvider || !promptRows.length} onClick={() => run('to-prompts')}>
          Propose prompts from sheet ({promptRows.length} checked)
        </button>
        <button type="button" className={button} disabled={busy || disabled || noProvider || !splitRows.length} onClick={() => run('split')}>
          Split frame prompts into details ({splitRows.length})
        </button>
        <button type="button" className={button} disabled={busy || disabled || noProvider || !tightenRows.length} onClick={() => run('tighten')}>
          Tighten prompts ({tightenRows.length})
        </button>
        <button type="button" className={button} disabled={busy || !backfillRows.length} onClick={() => preview('from-prompts')}>Preview fill prompt</button>
        <button type="button" className={button} disabled={busy || !splitRows.length} onClick={() => preview('split')}>Preview split prompt</button>
        <button type="button" className={button} disabled={busy || !promptRows.length} onClick={() => preview('to-prompts')}>Preview shot prompt</button>
        <button type="button" className={button} disabled={busy || !tightenRows.length} onClick={() => preview('tighten')}>Preview tighten prompt</button>
        {busy && progress && (
          <>
            <span role="status" className="text-xs text-port-text-muted">{progress}</span>
            <button type="button" className={button} onClick={() => { stop.current = true; }}>Stop after this batch</button>
          </>
        )}
      </div>
      {error && <p role="alert" className="text-xs text-port-error">{error}</p>}
      {sent && <SentPromptPanel {...sent} />}
      {review && (
        <div className="min-w-0 space-y-2">
          {review.items.length === 0 && !busy && <p className="text-xs text-port-text-muted">Nothing to change.</p>}
          {review.items.length > 0 && (
            <button type="button" className={button} disabled={busy || !selectedCount} onClick={apply}>Apply {selectedCount} selected</button>
          )}
          <ul className="min-w-0 space-y-2">
            {review.items.map((item) => (
              <li key={item.sceneId} className="min-w-0 space-y-1 rounded border border-port-border p-2">
                <label className="flex min-h-[44px] items-center gap-1 text-xs font-medium pointer-fine:sm:min-h-0">
                  <input type="checkbox" aria-label={`Apply ${item.label}`} checked={item.selected} disabled={applying} onChange={(event) => change(item.sceneId, (current) => ({ ...current, selected: event.target.checked }))} /> {item.label}
                </label>
                {review.direction === 'split'
                  ? <SplitReview item={item} scene={sceneNow(item.sceneId)} cameras={project.cameras || []} disabled={applying} onEdit={(value) => change(item.sceneId, (current) => ({ ...current, generalPrompt: value }))} />
                  : review.direction === 'from-prompts'
                  ? <BackfillReview item={item} scene={sceneNow(item.sceneId)} cameras={project.cameras || []} />
                  : <PromptReview item={item} scene={sceneNow(item.sceneId)} disabled={applying} onEdit={(field, value) => change(item.sceneId, (current) => ({ ...current, proposed: { ...current.proposed, [field]: value } }))} />}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
