import { useState } from 'react';
import { Sparkles, Plus, Trash2, Save, X, Loader2 } from 'lucide-react';
import toast from '../ui/Toast';
import { createCatalogType, updateCatalogType, deleteCatalogType } from '../../services/apiCatalogTypes';
import { useCatalogTypes } from '../../hooks/useCatalogTypes.jsx';
import { USER_TYPE_FIELD_KINDS } from '../../lib/catalogTypes';

/**
 * Settings → Catalog tab. Lists the built-in (system) ingredient types
 * read-only and lets the user define their own custom types — each with a flat
 * list of typed fields the generic editor renders. Definitions persist in
 * settings.json server-side (via the /api/catalog/types routes) and federate to
 * peers; the local registry refreshes immediately on save.
 *
 * There is NO per-type React file — a user type is purely data: an id, a label,
 * a primary content key, and a list of { key, label, kind } fields.
 */

const KIND_LABELS = { string: 'Short text', longtext: 'Long text', tags: 'Tags', ref: 'Ingredient link' };
const slugify = (s) => String(s || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);

const emptyDraft = () => ({ id: '', label: '', primaryContentKey: '', fields: [] });

export function CatalogTypesTab() {
  const { types, refresh, loading } = useCatalogTypes();
  const systemTypes = types.filter((t) => t.system !== false);
  const userTypes = types.filter((t) => t.system === false);

  // `editing` is null (none), 'new' (add form), or a user-type id (edit form).
  const [editing, setEditing] = useState(null);
  const [draft, setDraft] = useState(emptyDraft());
  const [busy, setBusy] = useState(false);
  const [armedDeleteId, setArmedDeleteId] = useState(null);

  const startNew = () => { setDraft(emptyDraft()); setEditing('new'); };
  const startEdit = (t) => {
    setDraft({
      id: t.id,
      label: t.label,
      primaryContentKey: t.primaryContentKey || '',
      fields: (t.editorFields || []).map((f) => ({
        key: f.key,
        label: f.label,
        // editorFields carry the widget kind; map back to the server field kind.
        kind: f.widget === 'textarea' ? 'longtext' : f.widget === 'text' ? 'string' : f.widget,
      })),
    });
    setEditing(t.id);
  };
  const cancel = () => { setEditing(null); setDraft(emptyDraft()); };

  const addField = () => setDraft((d) => ({ ...d, fields: [...d.fields, { key: '', label: '', kind: 'string' }] }));
  const updateField = (i, patch) => setDraft((d) => ({
    ...d,
    fields: d.fields.map((f, idx) => (idx === i ? { ...f, ...patch } : f)),
  }));
  const removeField = (i) => setDraft((d) => ({ ...d, fields: d.fields.filter((_, idx) => idx !== i) }));

  const save = async () => {
    const id = editing === 'new' ? slugify(draft.id || draft.label) : draft.id;
    const label = draft.label.trim();
    if (!id || !label) { toast.error('Type needs an id and a label'); return; }
    const fields = draft.fields
      .map((f) => ({ key: slugify(f.key || f.label).replace(/-/g, '_'), label: (f.label || f.key).trim(), kind: f.kind }))
      .filter((f) => f.key && f.label);
    const primaryContentKey = draft.primaryContentKey || fields[0]?.key || 'description';
    const body = { id, label, primaryContentKey, fields };
    setBusy(true);
    const action = editing === 'new'
      ? createCatalogType(body, { silent: true })
      : updateCatalogType(id, body, { silent: true });
    const ok = await action.then(() => true).catch((err) => {
      toast.error(err?.message || 'Failed to save type');
      return false;
    });
    setBusy(false);
    if (!ok) return;
    toast.success(`Saved type "${label}"`);
    cancel();
    refresh();
  };

  const confirmDelete = async (id, { force = false } = {}) => {
    setBusy(true);
    const ok = await deleteCatalogType(id, { force, silent: true })
      .then(() => true)
      .catch((err) => {
        // 409 with the in-use code → offer a forced delete inline.
        if (err?.code === 'CATALOG_TYPE_IN_USE' || /force=true/.test(err?.message || '')) {
          toast.error('Type has ingredients — confirm again to delete anyway');
          setArmedDeleteId(`force:${id}`);
        } else {
          toast.error(err?.message || 'Failed to delete type');
        }
        return false;
      });
    setBusy(false);
    if (!ok) return;
    toast.success('Type deleted');
    setArmedDeleteId(null);
    refresh();
  };

  return (
    <div className="space-y-6">
      <div className="bg-port-card border border-port-border rounded-lg p-4 sm:p-6">
        <div className="flex items-center justify-between gap-3 mb-2">
          <div className="flex items-center gap-2">
            <Sparkles size={16} className="text-port-accent" />
            <h3 className="text-lg font-semibold text-white">Catalog types</h3>
          </div>
          {editing === null && (
            <button type="button" onClick={startNew}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-port-accent hover:bg-port-accent/90 text-white text-sm font-medium">
              <Plus size={14} aria-hidden="true" /> New type
            </button>
          )}
        </div>
        <p className="text-sm text-gray-400 mb-4">
          Define custom ingredient types for the Catalog. Built-in types are read-only;
          your custom types federate to your other machines.
        </p>

        {loading && <p className="text-sm text-gray-500">Loading types…</p>}

        {/* Built-in (system) types — read-only */}
        <div className="mb-5">
          <h4 className="text-xs uppercase tracking-wider text-gray-500 mb-2">Built-in</h4>
          <div className="flex flex-wrap gap-2">
            {systemTypes.map((t) => (
              <span key={t.id} className={`inline-block text-[11px] px-2 py-1 rounded border ${t.badgeColor}`}>
                {t.label}
              </span>
            ))}
          </div>
        </div>

        {/* User types */}
        <div>
          <h4 className="text-xs uppercase tracking-wider text-gray-500 mb-2">Your types</h4>
          {userTypes.length === 0 && editing !== 'new' && (
            <p className="text-sm text-gray-500">No custom types yet.</p>
          )}
          <div className="space-y-2">
            {userTypes.map((t) => (
              <div key={t.id} className="flex items-center justify-between gap-3 p-3 bg-port-bg border border-port-border rounded">
                <div className="min-w-0">
                  <div className="text-white text-sm font-medium truncate">{t.label}</div>
                  <div className="text-xs text-gray-500 font-mono">{t.id} · {(t.editorFields || []).length} field(s)</div>
                </div>
                <div className="flex items-center gap-2">
                  <button type="button" onClick={() => startEdit(t)} disabled={editing !== null}
                    className="px-2 py-1.5 rounded border border-port-border text-gray-300 hover:text-white text-sm disabled:opacity-40">
                    Edit
                  </button>
                  {armedDeleteId === t.id || armedDeleteId === `force:${t.id}` ? (
                    <span className="inline-flex items-center gap-1">
                      <button type="button" disabled={busy}
                        onClick={() => confirmDelete(t.id, { force: armedDeleteId === `force:${t.id}` })}
                        className="inline-flex items-center gap-1 px-2 py-1.5 rounded bg-port-error/20 text-port-error hover:bg-port-error/30 text-sm">
                        {busy ? <Loader2 size={13} className="animate-spin" /> : <Trash2 size={13} />} Confirm
                      </button>
                      <button type="button" onClick={() => setArmedDeleteId(null)}
                        className="px-2 py-1.5 rounded text-gray-400 hover:text-white text-sm">Cancel</button>
                    </span>
                  ) : (
                    <button type="button" onClick={() => setArmedDeleteId(t.id)} disabled={editing !== null}
                      aria-label={`Delete ${t.label}`}
                      className="px-2 py-1.5 rounded border border-port-border text-gray-400 hover:text-port-error text-sm disabled:opacity-40">
                      <Trash2 size={13} />
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Add / edit field-builder */}
      {editing !== null && (
        <div className="bg-port-card border border-port-border rounded-lg p-4 sm:p-6 space-y-4">
          <h3 className="text-lg font-semibold text-white">{editing === 'new' ? 'New type' : `Edit "${draft.label || draft.id}"`}</h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label htmlFor="catalog-type-label" className="block text-xs uppercase tracking-wider text-gray-500 mb-1">Label</label>
              <input id="catalog-type-label" type="text" value={draft.label} maxLength={80}
                onChange={(e) => setDraft((d) => ({ ...d, label: e.target.value }))}
                placeholder="e.g. Faction"
                className="w-full px-3 py-2 bg-port-bg border border-port-border rounded text-white text-sm" />
            </div>
            <div>
              <label htmlFor="catalog-type-id" className="block text-xs uppercase tracking-wider text-gray-500 mb-1">
                Id {editing !== 'new' && <span className="normal-case text-gray-600">(immutable)</span>}
              </label>
              <input id="catalog-type-id" type="text"
                value={editing === 'new' ? draft.id : draft.id}
                disabled={editing !== 'new'} maxLength={32}
                onChange={(e) => setDraft((d) => ({ ...d, id: e.target.value }))}
                placeholder="auto from label"
                className="w-full px-3 py-2 bg-port-bg border border-port-border rounded text-white text-sm font-mono disabled:opacity-50" />
            </div>
          </div>

          <div>
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs uppercase tracking-wider text-gray-500">Fields</span>
              <button type="button" onClick={addField}
                className="inline-flex items-center gap-1 px-2 py-1 rounded border border-port-border text-gray-300 hover:text-white text-xs">
                <Plus size={12} /> Add field
              </button>
            </div>
            {draft.fields.length === 0 && <p className="text-sm text-gray-500">No fields — add at least one.</p>}
            <div className="space-y-2">
              {draft.fields.map((f, i) => (
                <div key={i} className="grid grid-cols-1 sm:grid-cols-[1fr_1fr_160px_auto] gap-2 items-end">
                  <div>
                    <label htmlFor={`field-label-${i}`} className="block text-[10px] uppercase tracking-wider text-gray-500 mb-1">Field label</label>
                    <input id={`field-label-${i}`} type="text" value={f.label} maxLength={80}
                      onChange={(e) => updateField(i, { label: e.target.value })}
                      placeholder="e.g. Headquarters"
                      className="w-full px-2 py-1.5 bg-port-bg border border-port-border rounded text-white text-sm" />
                  </div>
                  <div>
                    <label htmlFor={`field-key-${i}`} className="block text-[10px] uppercase tracking-wider text-gray-500 mb-1">Key</label>
                    <input id={`field-key-${i}`} type="text" value={f.key} maxLength={64}
                      onChange={(e) => updateField(i, { key: e.target.value })}
                      placeholder="auto from label"
                      className="w-full px-2 py-1.5 bg-port-bg border border-port-border rounded text-white text-sm font-mono" />
                  </div>
                  <div>
                    <label htmlFor={`field-kind-${i}`} className="block text-[10px] uppercase tracking-wider text-gray-500 mb-1">Kind</label>
                    <select id={`field-kind-${i}`} value={f.kind}
                      onChange={(e) => updateField(i, { kind: e.target.value })}
                      className="w-full px-2 py-1.5 bg-port-bg border border-port-border rounded text-white text-sm">
                      {USER_TYPE_FIELD_KINDS.map((k) => <option key={k} value={k}>{KIND_LABELS[k] || k}</option>)}
                    </select>
                  </div>
                  <button type="button" onClick={() => removeField(i)} aria-label="Remove field"
                    className="px-2 py-1.5 rounded border border-port-border text-gray-400 hover:text-port-error">
                    <X size={14} />
                  </button>
                </div>
              ))}
            </div>
          </div>

          <div>
            <label htmlFor="catalog-type-primary" className="block text-xs uppercase tracking-wider text-gray-500 mb-1">
              Primary content field <span className="normal-case text-gray-600">(the body shown in the quick-create form)</span>
            </label>
            <select id="catalog-type-primary" value={draft.primaryContentKey}
              onChange={(e) => setDraft((d) => ({ ...d, primaryContentKey: e.target.value }))}
              className="w-full px-3 py-2 bg-port-bg border border-port-border rounded text-white text-sm">
              <option value="">(first field)</option>
              {draft.fields.filter((f) => f.key || f.label).map((f, i) => (
                <option key={i} value={slugify(f.key || f.label).replace(/-/g, '_')}>{f.label || f.key}</option>
              ))}
            </select>
          </div>

          <div className="flex justify-end gap-2">
            <button type="button" onClick={cancel} className="px-3 py-2 rounded-lg text-gray-400 hover:text-white text-sm">Cancel</button>
            <button type="button" onClick={save} disabled={busy}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-port-accent hover:bg-port-accent/90 disabled:opacity-50 text-white text-sm font-medium">
              {busy ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />} Save type
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default CatalogTypesTab;
