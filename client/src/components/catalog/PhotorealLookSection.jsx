import { useEffect, useRef, useState } from 'react';
import { Check, Loader2, Sparkles, X } from 'lucide-react';
import toast from '../ui/Toast';
import MusicVideoLlmPicker from '../musicVideo/MusicVideoLlmPicker';
import SentPromptPanel from '../media/SentPromptPanel';
import PhotorealTexturesSection from './PhotorealTexturesSection';
import ConfirmButtonPair from '../ui/ConfirmButtonPair';
import { draftCatalogPhotorealLook, previewCatalogPhotorealLookPrompt, saveCatalogPhotorealLook } from '../../services/apiCatalog';
import { formatPercent } from '../../utils/formatters';

const actionButton = 'min-h-[40px] inline-flex items-center justify-center gap-1.5 rounded-lg border border-port-border px-3 text-sm text-gray-200 hover:border-port-accent/60 hover:text-white disabled:opacity-40';
const EMPTY_LLM = { providerId: '', model: '', effort: '' };
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function LookSummary({ look, scene }) {
  const zoneLabel = (id) => scene.zones.find((z) => z.id === id)?.label || id;
  const partLabel = (id) => scene.parts.find((p) => p.id === id)?.label || id;
  const { haze, exposure, sun } = look.atmosphere;
  return (
    <div className="space-y-2">
      <p className="text-xs text-gray-400">
        {plural(look.materials.length, 'material')} · {plural(look.lights.length, 'light')} · haze {formatPercent(haze * 100, { decimals: 0 })}
        {exposure ? ` · exposure ${exposure > 0 ? '+' : ''}${exposure}` : ''}{sun ? ' · sun on' : ''}
      </p>
      {look.materials.length > 0 && (
        <ul className="flex flex-wrap gap-1.5" aria-label="Materials">
          {look.materials.map((m) => (
            <li key={m.id} className="inline-flex items-center gap-1.5 rounded-full border border-port-border px-2 py-1 text-[11px] text-gray-300">
              <span className="h-3 w-3 rounded-full border border-white/20" style={{ backgroundColor: m.color }} aria-hidden="true" />
              {m.zone ? zoneLabel(m.zone) : partLabel(m.part)}: {m.preset}{m.wear ? ', worn' : ''}{m.emission ? ', glowing' : ''}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Dress with AI: materials, lights and atmosphere for the Blender render of this
 * place's greybox. The draft is a preview; Apply saves it as a catalog revision.
 */
export default function PhotorealLookSection({ record, scene, readOnly = false, disabled = false, onBusyChange, onSaved }) {
  const saved = record.payload?.photoreal ?? null;
  const [instruction, setInstruction] = useState('');
  const [llm, setLlm] = useState(EMPTY_LLM);
  const [fromScratch, setFromScratch] = useState(false);
  const [preview, setPreview] = useState(null);
  const [draft, setDraft] = useState(null);
  const [busy, setBusy] = useState('');
  const [confirmClear, setConfirmClear] = useState(false);
  const inFlight = useRef(false);
  const blocked = !!busy || disabled;
  const useCurrent = Boolean(saved) && !fromScratch;

  // The prompt a draft would send, composed by the server before the tap.
  useEffect(() => {
    if (!instruction.trim()) { setPreview(null); return undefined; }
    let active = true;
    const timer = setTimeout(() => {
      previewCatalogPhotorealLookPrompt(record.id, { instruction, useCurrent }, { silent: true })
        .then((res) => { if (active) setPreview(res); })
        .catch(() => { if (active) setPreview(null); });
    }, 400);
    return () => { active = false; clearTimeout(timer); };
  }, [record.id, record.updatedAt, instruction, useCurrent]);

  const run = (name, fn) => {
    if (inFlight.current || disabled) return Promise.resolve();
    inFlight.current = true;
    setBusy(name);
    onBusyChange?.(true);
    return fn().finally(() => {
      inFlight.current = false;
      setBusy('');
      onBusyChange?.(false);
    });
  };

  const persist = async (look, source) => {
    const updated = await saveCatalogPhotorealLook(record.id, look, { source, silent: true })
      .catch((err) => { toast.error(err?.message || 'Failed to save the look'); return null; });
    if (updated) onSaved?.(updated);
    return updated;
  };

  const generate = () => run('draft', async () => {
    const res = await draftCatalogPhotorealLook(record.id, { instruction, ...llm, useCurrent }, { silent: true })
      .catch((err) => { toast.error(err?.message || 'The model could not dress this place'); return null; });
    if (res) setDraft(res);
  });
  const apply = () => run('apply', async () => {
    if (await persist(draft.look, 'refine')) {
      setDraft(null);
      setInstruction('');
      toast.success('Look saved; render to see it');
    }
  });
  const clear = () => run('clear', async () => {
    if (await persist(null)) setConfirmClear(false);
  });

  return (
    <div className="rounded-lg border border-port-border p-3 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-medium text-white flex items-center gap-1.5"><Sparkles size={14} aria-hidden="true" />Look</h3>
        {saved && !readOnly && (confirmClear
          ? <ConfirmButtonPair prompt="Remove the look?" confirmText="Remove" onConfirm={clear} onCancel={() => setConfirmClear(false)} busy={busy === 'clear'} busyText="Removing…" />
          : <button type="button" className="text-xs text-gray-400 hover:text-white underline min-h-[32px]" onClick={() => setConfirmClear(true)} disabled={blocked}>Remove look</button>)}
      </div>
      {saved ? <LookSummary look={saved} scene={scene} /> : <p className="text-xs text-gray-400">No look yet: renders use flat zone colors and a daylight sun.</p>}
      {saved && (
        <PhotorealTexturesSection record={record} look={saved} readOnly={readOnly} disabled={blocked}
          onBusyChange={onBusyChange} onSaved={onSaved} />
      )}

      {draft && (
        <div role="status" className="rounded-lg border border-port-accent/50 bg-port-accent/10 p-3 space-y-3">
          <p className="text-sm text-white">
            Draft look, not saved yet ({draft.providerId}{draft.model ? ` › ${draft.model}` : ''}).{draft.edited ? ' This replaces the current look.' : ''}
          </p>
          <LookSummary look={draft.look} scene={scene} />
          <SentPromptPanel prompt={instruction} sentPrompt={draft.sentPrompt} additions={draft.promptAdditions} />
          <div className="flex flex-wrap gap-2">
            <button type="button" className={actionButton} onClick={apply} disabled={blocked || readOnly}>
              {busy === 'apply' ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <Check size={14} aria-hidden="true" />} Apply look
            </button>
            <button type="button" className={actionButton} onClick={() => setDraft(null)} disabled={blocked}>
              <X size={14} aria-hidden="true" /> Discard
            </button>
          </div>
        </div>
      )}

      {!readOnly && (
        <>
          <MusicVideoLlmPicker idPrefix="photoreal-look" value={llm} onChange={setLlm} label="Provider › model › effort"
            emptyProviderOption="Default — the active provider" fallbackName="The active provider"
            hint="Runs only when you tap the button. The place, its greybox parts and your words are sent as shown under Show full prompt." />
          <div>
            <label htmlFor="photoreal-look-instruction" className="block text-xs text-gray-400 mb-1">
              {useCurrent ? 'What should change?' : 'Describe the look'}
            </label>
            <textarea id="photoreal-look-instruction" value={instruction} onChange={(e) => setInstruction(e.target.value)} rows={3} maxLength={4000}
              placeholder={useCurrent ? 'Warmer floor, add pink spots on the DJ booth, a little less haze' : 'A 1985 roller rink at night: waxed maple floor, black walls with neon, fluorescent ceiling panels, light haze'}
              className="w-full rounded-lg bg-port-bg border border-port-border p-2 text-sm text-white" />
          </div>
          {saved && (
            <label htmlFor="photoreal-look-scratch" className="flex items-center gap-2 text-xs text-gray-300 min-h-[32px]">
              <input id="photoreal-look-scratch" type="checkbox" checked={fromScratch} onChange={(e) => setFromScratch(e.target.checked)} />
              Start over instead of editing the current look
            </label>
          )}
          {preview && <SentPromptPanel prompt={instruction} sentPrompt={preview.sentPrompt} additions={preview.promptAdditions} />}
          <button type="button" className={actionButton} onClick={generate} disabled={blocked || !instruction.trim()}>
            {busy === 'draft' ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <Sparkles size={14} aria-hidden="true" />}
            {busy === 'draft' ? 'Drafting…' : useCurrent ? 'Draft the change' : 'Dress with AI'}
          </button>
        </>
      )}
    </div>
  );
}
