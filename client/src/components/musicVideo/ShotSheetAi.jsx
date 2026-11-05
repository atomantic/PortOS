import { useRef, useState } from 'react';
import ProviderModelSelector from '../ProviderModelSelector.jsx';
import SentPromptPanel from '../media/SentPromptPanel.jsx';
import useProviderModels from '../../hooks/useProviderModels.js';
import { proposeMusicVideoShotSheet } from '../../services/apiMusicVideo.js';
import { SHOT_SHEET_PROPOSE_BATCH, mergeShotSheetBackfill, normalizeShotSheet } from '../../../../server/lib/musicVideoShotSheet.js';

const button = 'min-h-[44px] rounded border border-port-border px-2 py-1 text-xs disabled:opacity-50 sm:min-h-0';
const input = 'w-full min-w-0 rounded border border-port-border bg-port-bg px-1.5 py-1 text-xs';
const FIELD_LABELS = { cameraId: 'Camera', holder: 'Held by', view: 'View', location: 'Location', light: 'Time and light', characters: 'Who', action: 'Action', emotion: 'Emotion', notes: 'Notes' };

const chunks = (items, size) => Array.from({ length: Math.ceil(items.length / size) }, (_, at) => items.slice(at * size, (at + 1) * size));

/** One proposed backfill: only the empty columns it would fill. */
function BackfillReview({ item, cameras }) {
  const show = (field, value) => (field === 'cameraId' ? cameras.find((camera) => camera.id === value)?.name || value : Array.isArray(value) ? value.join(', ') : value);
  return (
    <dl className="grid grid-cols-[6rem_minmax(0,1fr)] gap-x-2 text-xs">
      {item.filled.map((field) => (
        <div key={field} className="contents"><dt className="text-port-text-muted">{FIELD_LABELS[field] || field}</dt><dd className="break-words">{show(field, item.sheet[field])}</dd></div>
      ))}
    </dl>
  );
}

/** One proposed rewrite: current text beside an editable proposal, so the director has the last word. */
function PromptReview({ item, onEdit }) {
  return ['framePrompt', 'prompt'].filter((field) => item.proposed[field] !== undefined).map((field) => {
    const name = field === 'prompt' ? 'Motion prompt' : 'Frame prompt';
    return (
      <div key={field} className="grid min-w-0 gap-2 text-xs sm:grid-cols-2">
        <div className="min-w-0"><p className="font-medium">{name} now</p><p className="max-h-48 overflow-y-auto whitespace-pre-wrap break-words text-port-text-muted">{item.current[field] || 'None'}</p></div>
        <label className="block min-w-0"><span className="font-medium">{name} proposed</span>
          <textarea aria-label={`${item.label} ${name} proposed`} rows={6} maxLength={8000} value={item.proposed[field]} onChange={(event) => onEdit(field, event.target.value)} className={input} />
        </label>
      </div>
    );
  });
}

/**
 * AI help for the shot sheet, both ways and only on request: fill a shot's empty
 * columns from its existing prompts, or write its prompts from the sheet you
 * edited. Works on the shots currently listed. Every result is a proposal you
 * review, edit and select; nothing is saved until Apply, and Checked is yours alone.
 */
export default function ShotSheetAi({ project, rows, disabled, onApply }) {
  const llm = useProviderModels({ withEffort: true, silent: true });
  const [effort, setEffort] = useState('');
  const [executionOptions, setExecutionOptions] = useState({});
  const [instruction, setInstruction] = useState('');
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState('');
  const [error, setError] = useState('');
  const [sent, setSent] = useState(null);
  const [review, setReview] = useState(null);
  const stop = useRef(false);

  const backfillRows = rows.filter((row) => !row.sheet.checked);
  const promptRows = rows.filter((row) => row.sheet.checked);
  const targets = (direction) => (direction === 'from-prompts' ? backfillRows : promptRows);

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
    const items = [];
    stop.current = false;
    setBusy(true); setError(''); setReview(null);
    for (let at = 0; at < batches.length && !stop.current; at += 1) {
      setProgress(`Batch ${at + 1} of ${batches.length}`);
      const result = await request(direction, batches[at].map((row) => row.scene.sceneId)).catch((err) => { setError(err?.message || 'The provider failed.'); return null; });
      if (!result) break; // Whatever came back from earlier batches stays reviewable.
      setSent({ prompt: instruction, sentPrompt: result.sentPrompt, additions: result.promptAdditions });
      for (const shot of result.shots) {
        const row = byId.get(shot.sceneId);
        if (direction === 'from-prompts') {
          const merged = mergeShotSheetBackfill(row.scene.shotSheet || {}, shot.sheet);
          if (merged.filled.length) items.push({ sceneId: shot.sceneId, label: row.scene.label, selected: true, ...merged });
        } else {
          const { sceneId: _sceneId, ...proposed } = shot;
          items.push({ sceneId: shot.sceneId, label: row.scene.label, selected: true, proposed, current: { framePrompt: row.scene.framePrompt, prompt: row.scene.prompt } });
        }
      }
      setReview({ direction, items: [...items] });
    }
    setProgress(''); setBusy(false);
    if (!items.length) setReview({ direction, items: [] });
  };

  const change = (sceneId, update) => setReview((current) => ({ ...current, items: current.items.map((item) => (item.sceneId === sceneId ? update(item) : item)) }));

  const apply = async () => {
    setBusy(true);
    const left = [];
    for (const item of review.items) {
      if (!item.selected) { left.push(item); continue; }
      const patch = review.direction === 'from-prompts' ? { shotSheet: normalizeShotSheet(item.sheet) } : item.proposed;
      const saved = await onApply(item.sceneId, patch);
      if (!saved) left.push(item);
    }
    setBusy(false);
    setReview(left.length ? { ...review, items: left } : null);
  };

  const selectedCount = review?.items.filter((item) => item.selected).length || 0;
  const noProvider = !llm.selectedProviderId;
  return (
    <section aria-label="AI help" className="min-w-0 space-y-2 rounded border border-port-border p-2">
      <p className="text-xs text-port-text-muted">Works on the shots listed below. Nothing saves until you review it and press Apply, and AI never ticks Checked.</p>
      <ProviderModelSelector providers={llm.providers} selectedProviderId={llm.selectedProviderId} selectedModel={llm.selectedModel}
        availableModels={llm.availableModels} onProviderChange={(id) => { llm.setSelectedProviderId(id); setEffort(''); setExecutionOptions({}); }} onModelChange={llm.setSelectedModel}
        effort={effort} onEffortChange={setEffort} executionOptions={executionOptions} onExecutionOptionsChange={setExecutionOptions}
        loading={llm.loading} disabled={busy || disabled} />
      <textarea aria-label="Note for the AI" rows={2} maxLength={4000} value={instruction} onChange={(event) => setInstruction(event.target.value)} placeholder="Optional note for the AI" className={input} />
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className={button} disabled={busy || disabled || noProvider || !backfillRows.length} onClick={() => run('from-prompts')}>
          Fill empty columns from prompts ({backfillRows.length} unchecked)
        </button>
        <button type="button" className={button} disabled={busy || disabled || noProvider || !promptRows.length} onClick={() => run('to-prompts')}>
          Propose prompts from sheet ({promptRows.length} checked)
        </button>
        <button type="button" className={button} disabled={busy || !backfillRows.length} onClick={() => preview('from-prompts')}>Preview fill prompt</button>
        <button type="button" className={button} disabled={busy || !promptRows.length} onClick={() => preview('to-prompts')}>Preview shot prompt</button>
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
                <label className="flex min-h-[44px] items-center gap-1 text-xs font-medium sm:min-h-0">
                  <input type="checkbox" aria-label={`Apply ${item.label}`} checked={item.selected} onChange={(event) => change(item.sceneId, (current) => ({ ...current, selected: event.target.checked }))} /> {item.label}
                </label>
                {review.direction === 'from-prompts'
                  ? <BackfillReview item={item} cameras={project.cameras || []} />
                  : <PromptReview item={item} onEdit={(field, value) => change(item.sceneId, (current) => ({ ...current, proposed: { ...current.proposed, [field]: value } }))} />}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
