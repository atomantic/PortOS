import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import * as api from '../../services/api';
import Banner from '../ui/Banner';
import { formatDateShort } from '../../utils/formatters';

const EXAMPLE = {
  schemaVersion: 1,
  name: 'recipe.project-checkin',
  purpose: 'Collect matching Brain notes and current goals.',
  parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false },
  steps: [
    { id: 'search', tool: 'brain.search', arguments: { query: { input: 'query' } } },
    { id: 'goals', tool: 'goals.list', arguments: {} },
  ],
  outputs: { matches: { step: 'search', path: [] }, goals: { step: 'goals', path: [] } },
};
const buttonClass = 'min-h-10 rounded border border-port-border px-3 text-sm text-port-text hover:border-port-accent disabled:opacity-50';

function RecipeEditor({ id, onChanged, onSelect }) {
  const inputId = useId();
  const [detail, setDetail] = useState(null);
  const [text, setText] = useState(id === 'new' ? JSON.stringify(EXAMPLE, null, 2) : '');
  const [loading, setLoading] = useState(id !== 'new');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [validation, setValidation] = useState(null);
  const [reload, setReload] = useState(0);
  const active = useRef(false);
  const recipe = detail?.recipe;
  const dirty = recipe && text !== JSON.stringify(recipe.definition, null, 2);

  useEffect(() => {
    active.current = true;
    let cancelled = false;
    if (id !== 'new') {
      setLoading(true);
      setError(null);
      setValidation(null);
      api.getMindRecipe(id, { silent: true }).then((response) => {
        if (cancelled) return;
        setDetail(response);
        setText(JSON.stringify(response.recipe.definition, null, 2));
      }).catch((failure) => {
        if (!cancelled) setError(failure.status === 404 ? 'Recipe not found. Select another recipe or create one.' : failure.message);
      }).finally(() => { if (!cancelled) setLoading(false); });
    }
    return () => { cancelled = true; active.current = false; };
  }, [id, reload]);

  const run = (operation) => {
    setBusy(true);
    setError(null);
    setValidation(null);
    Promise.resolve().then(operation).catch((failure) => {
      if (!active.current) return;
      const location = [failure.context?.field, failure.context?.step && `step ${failure.context.step}`].filter(Boolean).join(' · ');
      const details = Array.isArray(failure.context?.details)
        ? failure.context.details.slice(0, 3).map((entry) => `${Array.isArray(entry.path) ? entry.path.join('.') : entry.path || 'definition'}: ${entry.message}`).join('; ')
        : '';
      setError(`${location ? `${location}: ` : ''}${failure.message}${details ? ` — ${details}` : ''}${failure.status === 409 ? ' Reload the saved revision before trying again; copy your draft first.' : ''}`);
    }).finally(() => { if (active.current) setBusy(false); });
  };

  const apply = (saved) => {
    onChanged(saved);
    if (!active.current) return;
    setDetail((current) => ({
      recipe: saved,
      versions: [{ revision: saved.activeRevision, definition: saved.definition, author: 'user', createdAt: saved.updatedAt }, ...(current?.versions || [])],
    }));
    setText(JSON.stringify(saved.definition, null, 2));
    if (id === 'new') onSelect(saved.id);
  };

  const save = () => run(async () => {
    const definition = JSON.parse(text);
    const saved = recipe
      ? await api.updateMindRecipe(id, { expectedRevision: recipe.activeRevision, definition }, { silent: true })
      : await api.createMindRecipe(definition, { silent: true });
    apply(saved);
  });
  const validate = () => run(async () => {
    const result = await api.validateMindRecipe(JSON.parse(text), { silent: true });
    if (active.current) setValidation(result);
  });

  if (loading) return <p role="status" className="text-sm text-port-text-muted">Loading recipe…</p>;
  return (
    <div className="min-w-0 space-y-3 rounded border border-port-border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-semibold text-port-text">{id === 'new' ? 'New recipe' : recipe?.name || 'Recipe unavailable'}</h3>
        {recipe && <span className="text-xs text-port-text-muted">Revision {recipe.activeRevision} · {recipe.archived ? 'Archived' : recipe.available === false ? 'Unavailable' : 'Saved'}</span>}
        <button type="button" className={buttonClass} onClick={() => onSelect(null)}>Close editor</button>
      </div>
      {error && <Banner tone="error" title="Recipe could not be completed">{error}</Banner>}
      {id !== 'new' && <button type="button" className={buttonClass} disabled={busy} onClick={() => setReload((value) => value + 1)}>Reload saved revision</button>}
      {(recipe || id === 'new') && <>
        <label htmlFor={inputId} className="block text-sm text-port-text">Recipe definition (JSON)</label>
        <textarea id={inputId} value={text} disabled={busy} onChange={(event) => { setText(event.target.value); setValidation(null); }} spellCheck={false} rows={18} className="w-full rounded border border-port-border bg-port-bg p-3 font-mono text-xs text-port-text disabled:opacity-50" />
        <p className="text-xs text-port-text-muted">Use a recipe.* name and closed object parameters (additionalProperties: false). Each step calls a supported read tool. Arguments bind a literal, an input parameter, or an earlier step output; output paths are arrays of field names or index strings. No scripts, expressions, or nested recipes.</p>
        {dirty && <p className="text-xs text-port-text-muted">Unsaved edits. Save a revision or reload the saved definition before archiving or restoring history.</p>}
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={validate} disabled={busy} className={buttonClass}>Validate definition</button>
          <button type="button" onClick={save} disabled={busy || recipe?.archived} className={buttonClass}>{id === 'new' ? 'Save recipe' : 'Save new revision'}</button>
          {recipe && !recipe.archived && <button type="button" disabled={busy || dirty} className={buttonClass} onClick={() => run(async () => apply(await api.archiveMindRecipe(id, recipe.activeRevision, { silent: true })))}>Archive recipe</button>}
        </div>
        {busy && <p role="status" className="text-xs text-port-text-muted">Working…</p>}
        {validation && <div role="status" className="space-y-1 text-sm text-port-success">
          <p>Definition valid. Validation does not run tools.</p>
          {(validation.runtimeChecks || []).map((check, index) => <p key={`${check.field}-${index}`} className="text-xs text-port-text-muted">{check.field}{check.step ? ` · step ${check.step}` : ''}: {check.message}</p>)}
        </div>}
        {recipe?.archived && <p className="text-xs text-port-text-muted">Restore a revision below to make this recipe active again.</p>}
        {detail?.versions?.length > 0 && <section aria-label="Revision history" className="space-y-2">
          <h4 className="text-sm font-semibold text-port-text">Revision history</h4>
          {detail.versions.map((version) => <div key={version.revision} className="rounded border border-port-border p-2">
            <details>
              <summary className="cursor-pointer text-sm text-port-text">Revision {version.revision} · {version.author}{version.createdAt ? ` · ${formatDateShort(version.createdAt)}` : ''}</summary>
              <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words text-xs text-port-text-muted">{JSON.stringify(version.definition, null, 2)}</pre>
            </details>
            <button type="button" disabled={busy || dirty || (!recipe.archived && version.revision === recipe.activeRevision)} className={`${buttonClass} mt-2`} onClick={() => run(async () => apply(await api.restoreMindRecipe(id, { expectedRevision: recipe.activeRevision, revision: version.revision }, { silent: true })))}>Restore revision {version.revision}</button>
          </div>)}
        </section>}
      </>}
    </div>
  );
}

export default function PersistentMindRecipeLibrary() {
  const [searchParams, setSearchParams] = useSearchParams();
  // Tools already lives in a URL-driven Mind panel; preserve that panel and its other parameters.
  const selected = searchParams.get('recipe');
  const [recipes, setRecipes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const mounted = useRef(false);
  const version = useRef(0);
  const load = useCallback(() => {
    if (!mounted.current) return;
    const request = ++version.current;
    setLoading(true);
    api.getMindRecipes({ silent: true }).then((result) => {
      if (request !== version.current) return;
      // Revisions only advance (including archive/restore), so a read started
      // before a local save must not replace that newer row or lose other rows.
      setRecipes((current) => {
        const merged = new Map((result.recipes || []).map((recipe) => [recipe.id, recipe]));
        for (const recipe of current) {
          if (!merged.has(recipe.id) || merged.get(recipe.id).activeRevision < recipe.activeRevision) merged.set(recipe.id, recipe);
        }
        return [...merged.values()];
      });
      setError(null);
    }).catch((failure) => { if (request === version.current) setError(failure.message); })
      .finally(() => { if (request === version.current) setLoading(false); });
  }, []);
  useEffect(() => {
    mounted.current = true;
    load();
    return () => { mounted.current = false; version.current += 1; };
  }, [load]);
  const onChanged = useCallback((recipe) => {
    if (!mounted.current) return;
    setRecipes((current) => current.some((entry) => entry.id === recipe.id)
      ? current.map((entry) => entry.id === recipe.id && entry.activeRevision <= recipe.activeRevision ? recipe : entry)
      : [recipe, ...current]);
    // Publish the completed mutation even if its editor closed. Refresh to
    // recover the complete library when the initial read was still pending.
    load();
  }, [load]);
  const onSelect = (id) => setSearchParams((current) => {
    const next = new URLSearchParams(current);
    if (id) next.set('recipe', id);
    else next.delete('recipe');
    return next;
  });
  return <section aria-label="Saved tool recipes" className="space-y-3 rounded border border-port-border bg-port-card p-4">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h2 className="text-base font-semibold text-port-text">Saved tool recipes</h2>
      <button type="button" className={buttonClass} onClick={() => onSelect('new')}>New recipe</button>
    </div>
    <p className="text-sm text-port-text-muted">Manage reusable read definitions and their history with Mind grants off. The Mind can reuse recipes when recipe management and every underlying read grant are enabled. Nothing executes when you save or validate.</p>
    {error && <Banner tone="error" title="Recipe library unavailable">{error} <button type="button" className={buttonClass} onClick={load}>Retry library</button></Banner>}
    {loading ? <p role="status" className="text-sm text-port-text-muted">Loading recipes…</p> : !recipes.length && !error ? <p className="text-sm text-port-text-muted">No saved recipes. Create one from the editable example.</p> : null}
    <ul className="space-y-2">
      {recipes.map((recipe) => <li key={recipe.id} className="flex flex-wrap items-center justify-between gap-2 rounded border border-port-border p-2">
        <button type="button" onClick={() => onSelect(recipe.id)} className="min-h-10 break-all text-left text-sm text-port-accent hover:underline" aria-current={selected === recipe.id ? 'true' : undefined}>{recipe.name}</button>
        <span className="text-xs text-port-text-muted">Revision {recipe.activeRevision} · {recipe.archived ? 'Archived' : recipe.available === false ? 'Unavailable' : 'Saved'}</span>
      </li>)}
    </ul>
    {selected && <RecipeEditor key={selected} id={selected} onChanged={onChanged} onSelect={onSelect} />}
  </section>;
}
