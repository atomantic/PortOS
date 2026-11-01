import { useId, useRef, useState } from 'react';
import { Pencil, Plus, RotateCcw, Trash2 } from 'lucide-react';
import ConfirmButtonPair from '../ui/ConfirmButtonPair.jsx';
import useMounted from '../../hooks/useMounted.js';
import { getMusicVideoCastAndSets } from '../../services/apiMusicVideo.js';

const buttonClass = 'flex min-h-[44px] items-center gap-1 rounded border border-port-border px-2 py-1 text-xs sm:min-h-0 disabled:opacity-50';
const fieldClass = 'w-full min-w-0 rounded border border-port-border bg-port-bg px-2 py-1.5 text-sm';

const PROTAGONIST_FIELDS = [['name', 'Name'], ['description', 'Who they are'], ['height', 'Height'], ['face', 'Face'], ['hair', 'Hair'], ['signature', 'Signature detail'], ['gesture', 'Gesture']];
const FORM_FIELDS = [['label', 'Label'], ['age', 'Age'], ['description', 'How they look at that age'], ['height', 'Height at that age'], ['hair', 'Hair'], ['wardrobe', 'Wardrobe'],
  ['era', 'Era (year or period)'], ['look', 'Film look of that memory']];
const CAST_FIELDS = [['name', 'Name'], ['role', 'Role'], ['description', 'Who they are'], ['height', 'Height'], ['face', 'Face'], ['hair', 'Hair'], ['wardrobe', 'Wardrobe']];
const SET_FIELDS = [['name', 'Name'], ['description', 'The empty place'], ['lighting', 'Lighting'], ['era', 'Era (year or period)'], ['look', 'Film look of that era']];
const TEST_FIELDS = [['action', 'What happens in the frame'], ['caption', 'Caption']];
const LONG = new Set(['description', 'action', 'face', 'wardrobe']);

// A prop line is "name: description"; a line without both halves is dropped.
const propLine = (line) => {
  const at = line.indexOf(':');
  const name = line.slice(0, at).trim();
  const description = line.slice(at + 1).trim();
  return at > 0 && name && description ? { name, description } : null;
};
const lines = (text) => String(text || '').split('\n').map((line) => line.trim()).filter(Boolean);
const cardIdentity = (projectId, revision, item) => JSON.stringify([projectId, revision, item?.key, item?.kind,
  item?.testIndex, item?.setId, item?.label, item?.prompt, item?.deps, item?.refKeys]);

// A select field: `[key, label, options]` with options as `[value, text]` pairs ('' = none).
const subjectField = (subjects, current) => ['subjectId', 'Catalog reference for this age',
  [['', 'None: draw from the main sheet'], ...subjects.map((s) => [s.id, s.castForm?.label ? `${s.name} (${s.castForm.label})` : s.name]),
    ...(current && !subjects.some((s) => s.id === current) ? [[current, 'A character no longer cast in this video']] : [])]];
const formField = (forms) => ['formId', 'Age shown', [['', 'Present day'], ...forms.map((f) => [f.id, f.label])]];

/**
 * What one card on the check-in edits, as `{ fields | list, values, toEdits, removeEdits }`:
 * the direction text the image is drawn from, and the PATCH body that saves or removes it.
 */
function editorFor(item, direction, adding = false, subjects = []) {
  const p = direction?.protagonist || {};
  const forms = p.forms || [];
  const formFields = (current) => (subjects.length || current ? [...FORM_FIELDS, subjectField(subjects, current)] : FORM_FIELDS);
  if (item.kind === 'character') {
    if (adding) {
      const fields = formFields('');
      return { fields, values: Object.fromEntries(fields.map(([key]) => [key, ''])),
        toEdits: (v) => ({ protagonist: { forms: [...forms, v] } }) };
    }
    return { fields: PROTAGONIST_FIELDS, values: Object.fromEntries(PROTAGONIST_FIELDS.map(([key]) => [key, p[key] || ''])),
      toEdits: (v) => ({ protagonist: v }) };
  }
  if (item.kind === 'expressions') {
    return { list: 'One mood per line: what the face, eyes and head do', values: { text: (p.expressions || []).join('\n') },
      toEdits: (v) => ({ protagonist: { expressions: lines(v.text) } }) };
  }
  if (item.kind === 'props') {
    const props = direction?.props || [];
    return { list: 'One prop per line: name: exactly how it looks', values: { text: props.map((prop) => `${prop.name}: ${prop.description}`).join('\n') },
      toEdits: (v) => ({ props: lines(v.text).map(propLine).filter(Boolean).map((prop) => {
        const prior = props.find((old) => old.name.toLowerCase() === prop.name.toLowerCase());
        return prior ? { ...prop, id: prior.id, owner: prior.owner || '' } : prop;
      }) }) };
  }
  if (item.kind === 'looks') {
    return { looks: true, values: { looks: (direction?.looks || []).map((look) => ({ ...look, originalName: look.name })) },
      toEdits: (v) => ({ looks: v.looks }) };
  }
  if (item.kind === 'form') {
    const form = forms.find((f) => f.id === item.formId) || {};
    const fields = formFields(form.subjectId);
    return { fields, values: Object.fromEntries(fields.map(([key]) => [key, form[key] || ''])),
      toEdits: (v) => ({ protagonist: { forms: forms.map((f) => (f.id === form.id ? { ...v, id: f.id } : f)) } }),
      removeEdits: () => ({ protagonist: { forms: forms.filter((f) => f.id !== form.id) } }) };
  }
  if (item.kind === 'cast') {
    const member = (direction?.cast || []).find((c) => c.id === item.castId) || {};
    return { fields: CAST_FIELDS, values: Object.fromEntries(CAST_FIELDS.map(([key]) => [key, member[key] || ''])),
      toEdits: (v) => ({ cast: [{ id: member.id, ...v }] }), removeEdits: () => ({ cast: [{ id: member.id, remove: true }] }) };
  }
  if (item.kind === 'plate') {
    const set = (direction?.sets || []).find((s) => s.id === item.setId) || {};
    // A procedural plate has no film stock or period of its own.
    const setFields = direction?.medium === 'procedural' ? SET_FIELDS.filter(([key]) => key !== 'era' && key !== 'look') : SET_FIELDS;
    return { fields: setFields, values: Object.fromEntries(setFields.map(([key]) => [key, set[key] || ''])),
      toEdits: (v) => ({ sets: [{ id: set.id, ...v }] }), removeEdits: () => ({ sets: [{ id: set.id, remove: true }] }) };
  }
  if (item.kind === 'test') {
    const index = (item.testIndex ?? 0) + 1;
    const test = item.test || (direction?.tests || [])[index - 1] || {};
    const testFields = forms.length || test.formId ? [...TEST_FIELDS, formField(forms)] : TEST_FIELDS;
    return { fields: testFields, values: Object.fromEntries(testFields.map(([key]) => [key, test[key] || ''])),
      toEdits: (v) => ({ tests: [{ index, ...Object.fromEntries(Object.entries(v).filter(([key, value]) => value !== (test[key] || ''))) }] }), removeEdits: () => ({ tests: [{ index, remove: true }] }) };
  }
  return null;
}

const BINDING_MISSING = {
  subject: 'The catalog character this age was linked to is no longer cast in this video, so it is drawn from the main sheet only.',
  image: 'The catalog character this age is linked to has no reference image yet, so it is drawn from the main sheet only.',
};

function ItemEditor({ editor, label, busy, onSave, onCancel }) {
  const baseId = useId();
  const [values, setValues] = useState(editor.values);
  const set = (key, value) => setValues((old) => ({ ...old, [key]: value }));
  return (
    <form className="space-y-2 rounded border border-port-border p-2" aria-label={`Edit ${label}`}
      onSubmit={(e) => { e.preventDefault(); onSave(editor.toEdits(values)); }}>
      {editor.looks ? (
        <div className="space-y-3">
          {values.looks.map((look, index) => (
            <fieldset key={look.originalName || index} className="space-y-2 rounded border border-port-border p-2">
              <legend className="text-xs">Look {index + 1}</legend>
              {[['name', 'Name'], ['description', 'Outfit'], ['chapters', 'Song sections']].map(([key, title]) => (
                <label key={key} className="block text-xs text-port-text-muted">{title}
                  <input className={fieldClass} value={look[key] || ''} onChange={(e) => set('looks', values.looks.map((entry, i) => i === index ? { ...entry, [key]: e.target.value } : entry))} />
                </label>
              ))}
              <button type="button" className={buttonClass} disabled={values.looks.length <= 1} onClick={() => set('looks', values.looks.filter((_, i) => i !== index))}>Remove look</button>
            </fieldset>
          ))}
          <button type="button" className={buttonClass} disabled={values.looks.length >= 4} onClick={() => set('looks', [...values.looks, { name: '', description: '', chapters: '' }])}>Add look</button>
        </div>
      ) : editor.list ? (
        <label htmlFor={`${baseId}-text`} className="block text-xs text-port-text-muted">{editor.list}
          <textarea id={`${baseId}-text`} rows={6} className={fieldClass} value={values.text} onChange={(e) => set('text', e.target.value)} />
        </label>
      ) : editor.fields.map(([key, name, options]) => (
        <label key={key} htmlFor={`${baseId}-${key}`} className="block text-xs text-port-text-muted">{name}
          {options ? (
            <select id={`${baseId}-${key}`} className={fieldClass} value={values[key]} onChange={(e) => set(key, e.target.value)}>
              {options.map(([value, text]) => <option key={value} value={value}>{text}</option>)}
            </select>
          ) : LONG.has(key)
            ? <textarea id={`${baseId}-${key}`} rows={3} className={fieldClass} value={values[key]} onChange={(e) => set(key, e.target.value)} />
            : <input id={`${baseId}-${key}`} className={fieldClass} value={values[key]} onChange={(e) => set(key, e.target.value)} />}
        </label>
      ))}
      <p className="text-[11px] text-port-text-muted">Saving re-renders this image and anything drawn from it.</p>
      <div className="flex flex-wrap gap-2">
        <button type="submit" disabled={busy} className={`${buttonClass} bg-port-accent text-white border-transparent`}>Save and re-render</button>
        <button type="button" onClick={onCancel} className={buttonClass}>Cancel</button>
      </div>
    </form>
  );
}

/**
 * One check-in card's own actions: render this image again, edit the direction
 * text it is drawn from (saving re-renders only what changed), remove a cast
 * member, set, test or other age from the sheet, and add another age to the
 * protagonist. Shown only while the stage is not working. `formSubjects` are the
 * catalog-linked characters an age may be grounded on.
 */
export default function CastAndSetsItemActions({ item, direction, revision, projectId, busy, formSubjects = [], onRegenerate, onEdit, onRefresh }) {
  const [mode, setMode] = useState(null);
  const [resolution, setResolution] = useState(null);
  const [pending, setPending] = useState(null);
  const [notice, setNotice] = useState(null);
  const mounted = useMounted();
  const savedIdentity = cardIdentity(projectId, revision, item);
  const identity = JSON.stringify([savedIdentity, item.test || null]);
  const currentIdentity = useRef(identity);
  const requestVersion = useRef(0);
  if (currentIdentity.current !== identity) {
    currentIdentity.current = identity;
    requestVersion.current += 1;
  }
  const loading = pending?.identity === identity && pending?.version === requestVersion.current;
  const resolvedTest = resolution?.identity === identity ? resolution.test : null;
  const currentMode = mode === 'edit' && resolution && !resolvedTest ? null : mode;
  const editor = editorFor(resolvedTest ? { ...item, test: resolvedTest } : item, direction, false, formSubjects);
  const label = item.label || item.key;
  const close = () => setMode(null);
  const save = async (edits) => { if (await onEdit(edits)) close(); };
  const edit = async () => {
    if (currentMode === 'edit') { close(); return; }
    setNotice(null);
    if (item.kind !== 'test' || item.test) { setResolution(null); setMode('edit'); return; }
    const version = ++requestVersion.current;
    setPending({ identity, version });
    try {
      const { stage } = await getMusicVideoCastAndSets(projectId, { silent: true });
      if (!mounted.current || requestVersion.current !== version || currentIdentity.current !== identity) return;
      const fresh = stage?.plan?.[item.key];
      if (cardIdentity(projectId, stage?.revision, fresh) !== savedIdentity) {
        const refreshed = await onRefresh?.(stage?.revision);
        if (mounted.current && requestVersion.current === version && currentIdentity.current === identity) {
          setNotice({ identity, text: refreshed ? 'This test changed. Try editing it again.' : 'This test changed. Refresh the project and try editing it again.' });
        }
        return;
      }
      if (!fresh?.test) {
        setNotice({ identity, text: 'Rebuild the check-in before editing this test.' });
        return;
      }
      setResolution({ identity, test: fresh.test });
      setMode('edit');
    } catch {
      if (mounted.current && requestVersion.current === version && currentIdentity.current === identity) setNotice({ identity, text: 'Could not load this test. Try again.' });
    } finally {
      if (mounted.current) setPending((current) => (current?.version === version ? null : current));
    }
  };
  const actionBusy = busy || loading;
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        <button type="button" disabled={actionBusy} onClick={() => onRegenerate([item.key])} className={buttonClass} aria-label={`Regenerate ${label}`}>
          <RotateCcw size={12} aria-hidden="true" /> Regenerate
        </button>
        {editor && !editor.missing && (
          <button type="button" disabled={actionBusy} onClick={edit} aria-expanded={currentMode === 'edit'} className={buttonClass} aria-label={`Edit ${label}`}>
            <Pencil size={12} aria-hidden="true" /> {loading ? 'Loading…' : 'Edit'}
          </button>
        )}
        {item.kind === 'character' && (direction?.protagonist?.forms || []).length < 3 && (
          <button type="button" disabled={actionBusy} onClick={() => setMode(mode === 'add' ? null : 'add')} aria-expanded={mode === 'add'} className={buttonClass}>
            <Plus size={12} aria-hidden="true" /> Add another age
          </button>
        )}
        {editor?.removeEdits && !editor.missing && mode !== 'remove' && (
          <button type="button" disabled={actionBusy} onClick={() => setMode('remove')} className={`${buttonClass} text-port-error`} aria-label={`Remove ${label}`}>
            <Trash2 size={12} aria-hidden="true" /> Remove
          </button>
        )}
        {mode === 'remove' && (
          <ConfirmButtonPair prompt="Remove?" confirmText="Remove" busy={busy} responsiveTouchTargets
            ariaLabel={`Remove ${label} from the sheet`} confirmAriaLabel={`Remove ${label} from the sheet`} onConfirm={() => save(editor.removeEdits())} onCancel={close} />
        )}
      </div>
      {BINDING_MISSING[item.bindingMissing] && <p className="text-xs text-port-warning">{BINDING_MISSING[item.bindingMissing]}</p>}
      {notice?.identity === identity && <p role="status" className="text-xs text-port-warning">{notice.text}</p>}
      {currentMode === 'edit' && <ItemEditor editor={editor} label={label} busy={busy} onSave={save} onCancel={close} />}
      {mode === 'add' && <ItemEditor editor={editorFor(item, direction, true, formSubjects)} label="another age" busy={busy} onSave={save} onCancel={close} />}
    </div>
  );
}
