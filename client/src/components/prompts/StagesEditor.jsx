// The Prompt Manager's Stages tab: the grouped stage catalogue and the
// selected stage's template / model / timeout editor.
import { useEffect, useState } from 'react';
import { Eye, Save, Trash2 } from 'lucide-react';
import toast from '../ui/Toast';
import { FormField } from '../ui/FormField';
import {
  getPrompts, getPrompt, createPrompt, savePrompt, deletePrompt, previewPrompt, getPromptUsage,
} from '../../services/apiPrompts';
import { getProviders } from '../../services/apiProviders';
import { getProviderTimeout } from '../../utils/providers';
import { parseTimeoutMs } from '../../utils/formatters';
import CatalogueNotice from './CatalogueNotice';
import CreateStageModal from './CreateStageModal';
import DeleteStageModal from './DeleteStageModal';
import PromptWorkspace from './PromptWorkspace';
import StageCatalogue, { useStageCatalogueFilter } from './StageCatalogue';
import StageModelField from './StageModelField';
import StageTimeoutField from './StageTimeoutField';
import usePromptCatalogue from './usePromptCatalogue';
import useRecordEditor from './useRecordEditor';
import useSelectionParam from './useSelectionParam';

// `systemStageKeys` is the CURATED system-stage list, served by GET
// /api/prompts (`server/lib/promptSystemStages.js`) rather than mirrored
// client-side, so the SYSTEM badge and the "System only" filter can never
// disagree with the server's own table (#3314). It is NOT the full
// delete-protected set — that one is wider and per-stage, and only `/usage`
// reports it (#3335).
const EMPTY_STAGES = Object.freeze({ stages: {}, systemStageKeys: [] });
const loadStages = () => getPrompts({ silent: true });
const selectStages = (res) => ({
  stages: res.stages || {},
  // `Array.isArray` rather than `|| []`: an older server that predates the
  // `systemStages` key sends nothing, which must read as "no system stages
  // known" (no badges, empty System-only filter) — never as a crash.
  systemStageKeys: Array.isArray(res.systemStages) ? res.systemStages : [],
});

const EMPTY_PROVIDERS = Object.freeze({ providers: [], activeProviderId: null });
const loadProviders = () => getProviders({ silent: true });
const selectProviders = (res) => ({
  providers: (res.providers || []).filter((p) => p.enabled),
  activeProviderId: res.activeProvider || null,
});

const BLANK_STAGE = Object.freeze({ template: '', config: Object.freeze({}) });
// Config is compared by serialization, not identity: every editor control
// rebuilds the object with a spread, so `!==` would read as dirty on a
// re-render that changed nothing. Every mutation spreads the previous object,
// so key order is stable and a newly added key (a timeout override) reads as
// the real change it is.
const sameStage = (a, b) => a.template === b.template && JSON.stringify(a.config) === JSON.stringify(b.config);

const loadStage = (name) => getPrompt(name, { silent: true });
const hydrateStage = (res) => {
  // Normalize a server-returned timeout via parseTimeoutMs so the editor
  // shares the validator's accept set: integers OR digit-only strings (e.g.
  // legacy `'900000'` from pre-validation installs) round-trip through the
  // UI, while non-positive / non-integer / garbage values (0, 'abc',
  // undefined, 1.5) collapse to null so the input doesn't surface them as
  // touched. Only set the key when the server actually shipped a value —
  // otherwise the next save would write `timeout: null` (the server's
  // explicit-clear sentinel) for stages the user never touched, conflating
  // "key absent" with "user cleared the override".
  const config = { name: res.name, description: res.description, model: res.model, provider: res.provider || null, variables: res.variables || [] };
  const timeout = parseTimeoutMs(res.timeout);
  if (timeout !== null) config.timeout = timeout;
  return { template: res.template || '', config };
};

export default function StagesEditor({ splitPane, reloadKey, onDirtyChange }) {
  const [selectedStage, setSelectedStage] = useSelectionParam('stage');
  const stagesCatalogue = usePromptCatalogue(loadStages, selectStages, EMPTY_STAGES, reloadKey);
  const providersCatalogue = usePromptCatalogue(loadProviders, selectProviders, EMPTY_PROVIDERS, reloadKey);
  const { stages, systemStageKeys } = stagesCatalogue.data;
  const { providers, activeProviderId } = providersCatalogue.data;
  const stagesFailed = stagesCatalogue.failed;
  // Narrow layouts only: the catalogue Drawer. Closed by every path that moves
  // the selection; merely opening it never touches editor state.
  const [chooserOpen, setChooserOpen] = useState(false);
  const [preview, setPreview] = useState('');
  const [saving, setSaving] = useState(false);
  const [creating, setCreating] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const filter = useStageCatalogueFilter({ stages, systemStageKeys, selectedStage });

  const editor = useRecordEditor({
    selected: selectedStage,
    blank: BLANK_STAGE,
    isEqual: sameStage,
    load: loadStage,
    hydrate: hydrateStage,
    onReset: () => setPreview(''),
    noun: 'prompt',
    onSwitch: (name) => switchStage(name),
    onReselect: () => setChooserOpen(false),
  });
  const { template, config } = editor.value;
  const setConfig = (fields) => editor.setValue((v) => ({ ...v, config: { ...v.config, ...fields } }));
  // Names the open stage the way the list row does, so the discard question
  // quotes the label the user actually clicked rather than its raw key.
  const openLabel = stages[selectedStage]?.name || selectedStage;

  useEffect(() => {
    onDirtyChange?.(editor.dirty ? openLabel : null);
    return () => onDirtyChange?.(null);
  }, [editor.dirty, openLabel, onDirtyChange]);

  const reloadCatalogues = () => Promise.all([stagesCatalogue.reload(), providersCatalogue.reload()]);

  // Through `editor.reset`, not a bare selection change, so the incoming stage
  // opens against a cleared baseline (#6021).
  const switchStage = (name) => {
    setChooserOpen(false);
    editor.reset();
    setPreview('');
    setSelectedStage(name);
  };

  const saveStage = async () => {
    if (!editor.ready || saving) return;
    setSaving(true);
    const sentFor = selectedStage;
    const sent = editor.value;
    const payload = { template: sent.template, ...sent.config };
    // Explicitly null provider when in tier mode so server clears any previous value
    if (!payload.provider) payload.provider = null;
    const ok = await savePrompt(sentFor, payload, { silent: true })
      .then(() => true)
      .catch((err) => { toast.error('Failed to save stage: ' + err.message); return false; });
    setSaving(false);
    if (!ok) return;
    toast.success(`Stage "${openLabel}" saved`);
    editor.markSaved(sentFor, sent);
    await reloadCatalogues();
  };

  const previewStage = async () => {
    if (!editor.ready || saving) return;
    const previewFor = selectedStage;
    const data = await previewPrompt(previewFor, {}, { silent: true })
      .catch((err) => { toast.error('Failed to preview: ' + err.message); return null; });
    if (!data || previewFor !== editor.liveRef.current.selected) return;
    setPreview(data.preview);
  };

  const createStage = async (form) => {
    setSaving(true);
    const payload = { ...form };
    // Strip provider field when in tier mode
    if (!payload.provider) delete payload.provider;
    const ok = await createPrompt(payload, { silent: true })
      .then(() => true)
      .catch((err) => { toast.error(err.message || 'Failed to create stage'); return false; });
    setSaving(false);
    if (!ok) return false;
    setCreating(false);
    toast.success(`Stage "${payload.name || payload.stageName}" created`);
    switchStage(payload.stageName);
    await reloadCatalogues();
    return true;
  };

  const requestDeleteStage = async (stageName) => {
    // Check if stage is in use. On failure fall back to "deletable" rather
    // than "protected" — a false `canDelete: false` would silently force-delete
    // a user stage, while a false `true` just lets the server's own guard
    // return SYSTEM_STAGE_PROTECTED, which the toast surfaces.
    const usage = await getPromptUsage(stageName, { silent: true })
      .catch(() => ({ isSystemStage: false, usedBy: [], referencedBy: [], canDelete: true }));
    setDeleteTarget({ stageName, ...usage });
  };

  const confirmDeleteStage = async () => {
    const { stageName, canDelete } = deleteTarget;
    setDeleteTarget(null);
    // The server refuses without ?force=true for BOTH the curated system set
    // and any stage its source references by name (#3335), so gate on
    // `canDelete` — `isSystemStage` alone would 400 on a pipeline stage.
    const ok = await deletePrompt(stageName, { force: canDelete === false }, { silent: true })
      .then(() => true)
      .catch((err) => { toast.error(`Failed to delete: ${err.message || 'Unknown error'}`); return false; });
    if (!ok) return;
    if (selectedStage === stageName) setSelectedStage(null);
    toast.success(`Stage "${stageName}" deleted`);
    await reloadCatalogues();
  };

  const catalogue = (
    <StageCatalogue
      filter={filter}
      catalogue={stagesCatalogue}
      selectedStage={selectedStage}
      dirty={editor.dirty}
      openLabel={openLabel}
      isPending={editor.isPending}
      onRequest={editor.request}
      onConfirmSwitch={switchStage}
      onCancelPending={editor.cancelPending}
      onNew={() => { setChooserOpen(false); setCreating(true); }}
    />
  );

  const stageEditor = selectedStage && !stages[selectedStage] && !stagesFailed ? (
    <div className="bg-port-card border border-port-border rounded-xl p-12 text-center text-gray-500">
      That stage could not be found — it may have been deleted or renamed.{' '}
      <button onClick={() => setSelectedStage(null)} className="text-port-accent hover:underline">
        Clear selection
      </button>
    </div>
  ) : selectedStage ? (
    <>
      <div className="bg-port-card border border-port-border rounded-xl p-4 @container">
        <div className="flex flex-col gap-3 mb-4 @sm:flex-row @sm:items-start @sm:justify-between">
          <div className="min-w-0 @sm:flex-1">
            <h3 className="break-words text-lg font-medium text-white">{config.name}</h3>
            {editor.dirty && (
              <div className="text-xs text-port-warning mt-1">Unsaved changes</div>
            )}
          </div>
          <div className="flex w-full max-w-full flex-wrap gap-2 @sm:w-auto @sm:shrink-0">
            <button
              onClick={previewStage}
              disabled={!editor.ready || saving}
              className="flex items-center gap-1 px-3 py-1 text-sm bg-port-border hover:bg-port-border/80 text-white rounded disabled:opacity-50"
            >
              <Eye size={14} /> Preview
            </button>
            <button
              onClick={saveStage}
              disabled={!editor.ready || saving}
              className="flex items-center gap-1 px-3 py-1 text-sm bg-port-accent hover:bg-port-accent/80 text-white rounded disabled:opacity-50"
            >
              <Save size={14} /> Save
            </button>
            {/* Delete lives here, not on the list row: a destructive control
                sitting beside 120+ select targets is a mis-tap waiting to
                happen (#3284). */}
            <button
              onClick={() => requestDeleteStage(selectedStage)}
              title="Delete stage"
              className="flex items-center gap-1 px-3 py-1 text-sm bg-port-border hover:bg-port-error text-gray-300 hover:text-white rounded"
            >
              <Trash2 size={14} /> Delete
            </button>
          </div>
        </div>

        {!editor.ready && (
          <div role={editor.readFailed ? 'alert' : 'status'} className="mb-4 text-sm text-gray-400">
            {editor.readFailed ? (
              <>Failed to load prompt: {editor.read.error}{' '}
                <button onClick={editor.retryRead} className="text-port-accent hover:underline">Retry</button>
              </>
            ) : 'Loading prompt details…'}
          </div>
        )}
        <div className="space-y-4 mb-4">
          <StageModelField
            value={config}
            onChange={setConfig}
            providers={providers}
            disabled={!editor.ready}
            notice={providersCatalogue.failed && (
              <CatalogueNotice label="Providers" stale={providersCatalogue.loaded} onRetry={providersCatalogue.reload} />
            )}
          />
          <StageTimeoutField
            key={selectedStage}
            disabled={!editor.ready}
            timeout={config.timeout}
            providerFallback={getProviderTimeout(providers, config.provider, activeProviderId)}
            onCommit={(ms) => setConfig({ timeout: ms })}
          />
          <div>
            <span className="block text-sm text-gray-400 mb-1">Variables Used</span>
            <div className="text-sm text-gray-300">
              {(config.variables || []).join(', ') || 'None'}
            </div>
          </div>
        </div>

        <FormField label="Template">
          <textarea
            disabled={!editor.ready}
            value={template}
            onChange={(e) => { const next = e.target.value; editor.setValue((v) => ({ ...v, template: next })); }}
            className="w-full h-96 px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white font-mono text-sm focus:border-port-accent focus:outline-hidden"
          />
          <p className="text-xs text-gray-500 mt-1">
            Use {'{{variable}}'} for substitution, {'{{#array}}...{{/array}}'} for iteration
          </p>
        </FormField>
      </div>

      {preview && (
        <div className="bg-port-card border border-port-border rounded-xl p-4">
          <h4 className="text-sm font-medium text-gray-400 mb-2">Preview</h4>
          <pre className="text-sm text-gray-300 whitespace-pre-wrap break-words bg-port-bg p-3 rounded max-h-64 overflow-auto">
            {preview}
          </pre>
        </div>
      )}
    </>
  ) : (
    <div className="bg-port-card border border-port-border rounded-xl p-12 text-center text-gray-500">
      Select a stage to edit
    </div>
  );

  return (
    <>
      <PromptWorkspace
        splitPane={splitPane}
        loading={!stagesCatalogue.settled || !providersCatalogue.settled}
        catalogue={catalogue}
        editor={stageEditor}
        active={Boolean(selectedStage)}
        noun="stage"
        title="Prompt Stages"
        chooserOpen={chooserOpen}
        onChooserOpenChange={setChooserOpen}
      />
      <CreateStageModal
        open={creating}
        onClose={() => setCreating(false)}
        providers={providers}
        saving={saving}
        onCreate={createStage}
      />
      <DeleteStageModal target={deleteTarget} onCancel={() => setDeleteTarget(null)} onConfirm={confirmDeleteStage} />
    </>
  );
}
