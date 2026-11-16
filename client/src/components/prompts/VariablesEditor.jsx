// The Prompt Manager's Variables tab: reusable template snippets, edited in
// place or drafted from the blank "+" form.
import { useEffect, useRef, useState } from 'react';
import { Plus, Save, Trash2 } from 'lucide-react';
import toast from '../ui/Toast';
import { FormField } from '../ui/FormField';
import InlineConfirmRow from '../ui/InlineConfirmRow';
import { useConfirmDelete } from '../../hooks/useConfirmDelete';
import {
  getPromptVariables, createPromptVariable, savePromptVariable, deletePromptVariable,
} from '../../services/apiPrompts';
import CatalogueNotice from './CatalogueNotice';
import PromptWorkspace from './PromptWorkspace';
import usePromptCatalogue from './usePromptCatalogue';
import useRecordEditor from './useRecordEditor';
import useSelectionParam from './useSelectionParam';

// Every editable field of a prompt variable, so the dirty check and the blank
// form can't drift apart when a field is added.
const VAR_FORM_FIELDS = ['key', 'name', 'category', 'content'];
const BLANK_VAR_FORM = Object.freeze({ key: '', name: '', category: '', content: '' });
const sameVarForm = (a, b) => VAR_FORM_FIELDS.every((f) => a[f] === b[f]);

const EMPTY_VARIABLES = Object.freeze({});
const loadVariables = () => getPromptVariables({ silent: true });
const selectVariables = (res) => res.variables || {};

export default function VariablesEditor({ splitPane, reloadKey, onDirtyChange }) {
  const [selectedVar, setSelectedVar] = useSelectionParam('var');
  const catalogue = usePromptCatalogue(loadVariables, selectVariables, EMPTY_VARIABLES, reloadKey);
  const variables = catalogue.data;
  const [chooserOpen, setChooserOpen] = useState(false);
  // Narrow layouts only: the "+" blank-variable draft has no URL param, so
  // this is what makes it the active editor instead of the catalogue.
  const [draftOpen, setDraftOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  // Variables delete inline-confirms in the row itself (#3935) — the trash icon
  // arms the row instead of firing DELETE on the first click.
  const { isConfirming, requestDelete, cancelDelete, confirmDelete } = useConfirmDelete();

  // Create mode counts as dirty too: a typed-but-unsaved draft is exactly the
  // work the "+" button and a list click would otherwise throw away, so the
  // baseline is the blank form rather than a `selectedVar` gate. No `load`:
  // the form hydrates from the catalogue below.
  const editor = useRecordEditor({
    selected: selectedVar,
    blank: BLANK_VAR_FORM,
    isEqual: sameVarForm,
    onSwitch: (key) => switchVariable(key),
    // The "+" (null key) is exempt: in create mode it still resets the draft.
    isCurrent: (key) => key !== null && key === selectedVar,
    onReselect: () => setChooserOpen(false),
    onPark: cancelDelete,
  });
  const form = editor.value;
  const setField = (field, value) => editor.setValue((prev) => ({ ...prev, [field]: value }));
  // Names the open editor the way its list row does, so the discard question
  // quotes the label the user is actually looking at — the list still shows the
  // stored name while an unsaved rename sits in the form. A create-mode draft
  // has no row yet, so it falls back to its typed key.
  const openLabel = selectedVar
    ? (variables[selectedVar]?.name || selectedVar)
    : (form.name || form.key || 'New Variable');

  useEffect(() => {
    onDirtyChange?.(editor.dirty ? openLabel : null);
    return () => onDirtyChange?.(null);
  }, [editor.dirty, openLabel, onDirtyChange]);

  // Hydrate the form from the URL-selected key. Depends on `variables` so it
  // fills in once the list loads, but a `hydratedRef` guard keyed on the
  // selected key ensures a later `variables` refresh (Reload, or deleting a
  // *different* variable) does NOT re-hydrate — which would silently discard
  // the open key's in-progress edits. Mirrors the hydratedRef pattern the
  // Authors / Artists editors use. No param means create mode.
  const hydratedRef = useRef(null);
  const { reset } = editor;
  useEffect(() => {
    if (!selectedVar) {
      hydratedRef.current = null;
      reset(BLANK_VAR_FORM);
      return;
    }
    if (variables[selectedVar] && hydratedRef.current !== selectedVar) {
      const v = variables[selectedVar];
      reset({ key: selectedVar, name: v.name || '', category: v.category || '', content: v.content || '' });
      hydratedRef.current = selectedVar;
    }
  }, [selectedVar, variables]);

  // Saving an existing variable used to deselect it and blank the editor, which
  // read as a crash rather than a success (#6023). The editor now stays open on
  // what was just saved, and a create adopts the new key as the selection.
  const saveVariable = async () => {
    setSaving(true);
    const sentFor = selectedVar;
    const sentForm = form;
    const ok = await (sentFor
      ? savePromptVariable(sentFor, sentForm, { silent: true })
      : createPromptVariable(sentForm, { silent: true }))
      .then(() => true)
      .catch((err) => { toast.error('Failed to save variable: ' + err.message); return false; });
    setSaving(false);
    if (!ok) return;
    toast.success(`Variable "${sentForm.name || sentForm.key}" ${sentFor ? 'saved' : 'created'}`);
    // Claim the hydration slot ahead of the refresh, so neither the reload nor
    // the selection change re-hydrates over what the user is looking at.
    if (editor.markSaved(sentFor, sentForm) && !sentFor) hydratedRef.current = sentForm.key;
    await catalogue.reload();
    // The URL adopts a newly created key only once the refreshed list holds it,
    // or the editor flashes its "variable could not be found" panel on the way.
    if (!sentFor && editor.liveRef.current.selected === null) setSelectedVar(sentForm.key);
  };

  const deleteVariable = async (key) => {
    const label = variables[key]?.name || key;
    const ok = await deletePromptVariable(key, { silent: true })
      .then(() => true)
      .catch((err) => { toast.error('Failed to delete variable: ' + err.message); return false; });
    if (!ok) return;
    toast.success(`Variable "${label}" deleted`);
    if (selectedVar === key) {
      switchVariable(null);
      // A deleted record leaves the catalogue, not a blank draft, behind.
      setDraftOpen(false);
    }
    await catalogue.reload();
  };

  const switchVariable = (key) => {
    setChooserOpen(false);
    setDraftOpen(key === null);
    hydratedRef.current = null;
    editor.reset();
    setSelectedVar(key);
  };

  const discardQuestion = (onConfirm) => ({
    className: 'rounded-lg',
    question: `Discard unsaved changes to "${openLabel}"?`,
    confirmText: 'Discard',
    cancelText: 'Keep editing',
    'aria-label': `Confirm discarding unsaved changes to ${openLabel}`,
    autoFocus: true,
    onConfirm,
    onCancel: editor.cancelPending,
  });

  const variableCatalogue = (
    <>
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-medium text-gray-400">Variables</h3>
        <button
          onClick={() => editor.request(null)}
          aria-label="Add variable"
          className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center p-1 text-port-accent hover:text-port-accent/80"
        >
          <Plus size={16} />
        </button>
      </div>
      {catalogue.failed && (
        <CatalogueNotice label="Variables" stale={catalogue.loaded} onRetry={catalogue.reload} />
      )}
      <div className="space-y-1">
        {/* The "+" has no list row of its own, so its discard question takes
            the top of the list. */}
        {editor.isPending(null) && <InlineConfirmRow {...discardQuestion(() => switchVariable(null))} />}
        {Object.entries(variables).sort(([a], [b]) => a.localeCompare(b)).map(([key, v]) => (
          editor.isPending(key) ? (
            <InlineConfirmRow key={key} {...discardQuestion(() => switchVariable(key))} />
          ) : isConfirming(key) ? (
            <InlineConfirmRow
              key={key}
              className="rounded-lg"
              question={`Delete "${v.name || key}"?`}
              confirmText="Delete"
              aria-label={`Confirm delete variable ${v.name || key}`}
              autoFocus
              onConfirm={() => confirmDelete(() => deleteVariable(key))}
              onCancel={cancelDelete}
            />
          ) : (
            <div
              key={key}
              className={`flex items-center justify-between px-3 py-2 rounded-lg text-sm ${
                selectedVar === key
                  ? 'bg-port-accent/20 text-port-accent'
                  : 'text-gray-300 hover:bg-port-border'
              }`}
            >
              <button
                onClick={() => editor.request(key)}
                className="flex-1 text-left"
              >
                <div className="flex items-center gap-2">
                  <span className="font-medium truncate">{v.name || key}</span>
                  {selectedVar === key && editor.dirty && (
                    <span className="shrink-0 text-[10px] px-1.5 py-0.5 bg-port-warning/20 text-port-warning rounded uppercase font-semibold">
                      Unsaved
                    </span>
                  )}
                </div>
                <div className="text-xs text-gray-500">{v.category || 'uncategorized'}</div>
              </button>
              <button
                onClick={() => { editor.cancelPending(); requestDelete(key); }}
                aria-label={`Delete variable ${v.name || key}`}
                className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center p-1 text-gray-500 hover:text-port-error"
              >
                <Trash2 size={14} />
              </button>
            </div>
          )
        ))}
      </div>
    </>
  );

  const variableEditor = selectedVar && !variables[selectedVar] && catalogue.failed ? (
    <div className="bg-port-card border border-port-border rounded-xl p-12 text-center text-gray-500">
      The variable list is unavailable, so this variable cannot be shown.{' '}
      <button onClick={catalogue.reload} className="text-port-accent hover:underline">
        Retry variables
      </button>
    </div>
  ) : selectedVar && !variables[selectedVar] ? (
    <div className="bg-port-card border border-port-border rounded-xl p-12 text-center text-gray-500">
      That variable could not be found — it may have been deleted.{' '}
      <button onClick={() => switchVariable(null)} className="text-port-accent hover:underline">
        New variable
      </button>
    </div>
  ) : (
    <div className="bg-port-card border border-port-border rounded-xl p-4 @container">
      <div className="flex flex-col gap-3 mb-4 @sm:flex-row @sm:items-start @sm:justify-between">
        <div className="min-w-0 @sm:flex-1">
          <h3 className="break-words text-lg font-medium text-white">
            {selectedVar ? `Edit: ${selectedVar}` : 'New Variable'}
          </h3>
          {editor.dirty && (
            <div className="text-xs text-port-warning mt-1">Unsaved changes</div>
          )}
        </div>
        <button
          onClick={saveVariable}
          disabled={saving || !form.key || !form.content}
          className="flex items-center gap-1 px-3 py-1 text-sm bg-port-accent hover:bg-port-accent/80 text-white rounded disabled:opacity-50"
        >
          <Save size={14} /> Save
        </button>
      </div>

      <div className="space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <FormField label="Key *">
            <input
              type="text"
              value={form.key}
              onChange={(e) => setField('key', e.target.value)}
              disabled={!!selectedVar}
              placeholder="variableKey"
              className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white focus:border-port-accent focus:outline-hidden disabled:opacity-50"
            />
          </FormField>
          <FormField label="Name">
            <input
              type="text"
              value={form.name}
              onChange={(e) => setField('name', e.target.value)}
              placeholder="Human Readable Name"
              className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white focus:border-port-accent focus:outline-hidden"
            />
          </FormField>
        </div>

        <FormField label="Category">
          <select
            value={form.category}
            onChange={(e) => setField('category', e.target.value)}
            className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white focus:border-port-accent focus:outline-hidden"
          >
            <option value="">Select category</option>
            <option value="response">Response Format</option>
            <option value="schema">Schema</option>
            <option value="rules">Rules</option>
            <option value="system">System</option>
          </select>
        </FormField>

        <FormField label="Content *">
          <textarea
            value={form.content}
            onChange={(e) => setField('content', e.target.value)}
            className="w-full h-48 px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white font-mono text-sm focus:border-port-accent focus:outline-hidden"
            placeholder="Variable content..."
          />
        </FormField>
      </div>
    </div>
  );

  return (
    <PromptWorkspace
      splitPane={splitPane}
      loading={!catalogue.settled}
      catalogue={variableCatalogue}
      editor={variableEditor}
      active={Boolean(selectedVar) || draftOpen || editor.dirty}
      noun="variable"
      title="Variables"
      chooserOpen={chooserOpen}
      onChooserOpenChange={setChooserOpen}
    />
  );
}
