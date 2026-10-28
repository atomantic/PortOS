import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router';
import IngredientPicker from '../IngredientPicker.jsx';
import toast from '../ui/Toast';
import { linkVideoSubjects, listVideoSubjectLinks } from '../../services/api';
import { ingredientPath } from '../../lib/creativeLibraries.js';

const buttonClass = 'min-h-[44px] rounded border border-port-border px-3 text-xs text-port-accent hover:bg-port-accent/10 disabled:opacity-50';
const selectClass = 'min-h-[44px] min-w-0 max-w-full rounded border border-port-border bg-port-bg px-2 text-xs';
const KIND_LABEL = { character: 'cast', place: 'environment', object: 'object' };

const recordForms = (ingredient) => (Array.isArray(ingredient?.payload?.forms) ? ingredient.payload.forms : [])
  .filter((f) => f?.id).map((f) => ({ id: f.id, label: f.label || f.age || f.id }));

/**
 * A music video's subjects and the catalog record each one is. An unlinked
 * subject named for an existing record ("Nora (17)") offers that record and
 * age in one tap; any other record can be picked. Linking keeps the subject's
 * own name and description. `type` limits it to one kind.
 */
export default function VideoCastLinks({ projectId, type, onLinked, idPrefix = 'video-cast' }) {
  const [subjects, setSubjects] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [pickFor, setPickFor] = useState(null);
  const [staged, setStaged] = useState(null);

  const load = useCallback(() => listVideoSubjectLinks(projectId, type, { silent: true })
    .then((res) => { setSubjects(res.subjects); setError(''); })
    .catch((err) => setError(err?.message || 'Could not load the video’s cast')), [projectId, type]);

  useEffect(() => { setSubjects(null); load(); }, [load]);

  const link = async (links) => {
    setBusy(true);
    const res = await linkVideoSubjects(projectId, links, { silent: true })
      .catch((err) => { toast.error(err?.message || 'Could not link'); return null; });
    if (res) {
      setStaged(null);
      onLinked?.(res);
      await load();
    }
    setBusy(false);
  };

  if (error) return <p role="alert" className="text-xs text-port-error">{error}</p>;
  if (!subjects) return <p className="text-xs text-port-text-muted">Loading the video’s cast…</p>;
  if (!subjects.length) return <p className="text-xs text-port-text-muted">This video has no {type ? `${KIND_LABEL[type]} ` : ''}subjects yet.</p>;

  const suggested = subjects.filter((s) => !s.ingredientId && s.suggestion);
  const pickSubject = subjects.find((s) => s.id === pickFor) || null;

  return (
    <div className="space-y-2 min-w-0">
      {suggested.length > 1 && (
        <button type="button" disabled={busy} className={buttonClass}
          onClick={() => link(suggested.map((s) => ({ subjectId: s.id, ingredientId: s.suggestion.ingredientId, ...(s.suggestion.formId ? { formId: s.suggestion.formId } : {}) })))}>
          Link all suggested ({suggested.length})
        </button>
      )}
      <ul className="space-y-1">
        {subjects.map((subject) => {
          const formsId = `${idPrefix}-${subject.id}-form`;
          const isStaged = staged?.subjectId === subject.id;
          return (
            <li key={subject.id} className="flex flex-wrap items-center gap-2 rounded border border-port-border p-2">
              <span className="min-w-0 flex-1 break-words text-sm">{subject.name}</span>
              {subject.ingredientId && subject.linked && <>
                <Link className="text-xs text-port-accent" to={ingredientPath({ id: subject.linked.id, type: subject.kind })}>{subject.linked.name}</Link>
                {subject.linked.forms.length > 0 && <>
                  <label htmlFor={formsId} className="sr-only">Age or look for {subject.name}</label>
                  <select id={formsId} disabled={busy} className={selectClass} value={subject.castForm?.id || ''}
                    onChange={(e) => link([{ subjectId: subject.id, ingredientId: subject.linked.id, ...(e.target.value ? { formId: e.target.value } : {}) }])}>
                    <option value="">Main look</option>
                    {subject.linked.forms.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
                  </select>
                </>}
                <button type="button" disabled={busy} className={buttonClass} aria-label={`Unlink ${subject.name}`}
                  onClick={() => link([{ subjectId: subject.id, ingredientId: null }])}>Unlink</button>
              </>}
              {subject.ingredientId && !subject.linked && <span className="text-xs text-port-warning">Its catalog record is gone</span>}
              {(!subject.ingredientId || !subject.linked) && !isStaged && <>
                {subject.suggestion && (
                  <button type="button" disabled={busy} className={buttonClass}
                    onClick={() => link([{ subjectId: subject.id, ingredientId: subject.suggestion.ingredientId, ...(subject.suggestion.formId ? { formId: subject.suggestion.formId } : {}) }])}>
                    Link to {subject.suggestion.name}{subject.suggestion.formLabel ? ` · ${subject.suggestion.formLabel}` : ''}
                  </button>
                )}
                <button type="button" disabled={busy} className={buttonClass} aria-label={`Pick a catalog record for ${subject.name}`}
                  onClick={() => setPickFor(subject.id)}>{subject.suggestion ? 'Other…' : 'Pick from catalog'}</button>
              </>}
              {isStaged && <>
                <span className="text-xs">{staged.name}</span>
                <label htmlFor={formsId} className="sr-only">Age or look for {subject.name}</label>
                <select id={formsId} className={selectClass} value={staged.formId} onChange={(e) => setStaged((s) => ({ ...s, formId: e.target.value }))}>
                  <option value="">Main look</option>
                  {staged.forms.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
                </select>
                <button type="button" disabled={busy} className={buttonClass}
                  onClick={() => link([{ subjectId: subject.id, ingredientId: staged.ingredientId, ...(staged.formId ? { formId: staged.formId } : {}) }])}>Link</button>
                <button type="button" className="min-h-[44px] text-xs text-port-text-muted" onClick={() => setStaged(null)}>Cancel</button>
              </>}
            </li>
          );
        })}
      </ul>
      <IngredientPicker
        open={!!pickSubject}
        type={pickSubject?.kind}
        onClose={() => setPickFor(null)}
        onSelect={(ingredient) => {
          const subject = pickSubject;
          setPickFor(null);
          if (!ingredient || !subject) return;
          const forms = recordForms(ingredient);
          if (forms.length) setStaged({ subjectId: subject.id, ingredientId: ingredient.id, name: ingredient.name, forms, formId: '' });
          else link([{ subjectId: subject.id, ingredientId: ingredient.id }]);
        }}
      />
    </div>
  );
}

/** Collapsed by default; the cast loads only once it is opened. */
export function VideoCastLinksDisclosure({ summary, summaryClassName, ...props }) {
  const [open, setOpen] = useState(false);
  return (
    <details className="w-full" onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary className={summaryClassName}>{summary}</summary>
      {open && <VideoCastLinks {...props} />}
    </details>
  );
}
