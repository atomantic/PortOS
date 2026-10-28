/**
 * CreativeCastImport — Casting › Import from music videos.
 *
 * Lists every music video's cast, sets and props that are not in the catalog
 * yet, each with the server's proposal (link to the universe, synced or
 * same-named record it matches, or create a new one). Each name match says why
 * it was suggested; a similar name is marked for checking. The director
 * reviews, changes any choice, and imports. "Keep in this video only" is
 * remembered on the video so it is not offered again.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { ArrowLeft, Import, Loader2, Sparkles } from 'lucide-react';
import PageHeader from '../components/PageHeader';
import MediaImage from '../components/MediaImage';
import IngredientPicker from '../components/IngredientPicker';
import toast from '../components/ui/Toast';
import { previewMusicVideoCastImport, commitMusicVideoCastImport } from '../services/apiCatalog';
import { libraryForType } from '../lib/creativeLibraries';
import { formatCount } from '../utils/formatters';

const decisionKey = (projectId, subjectId) => `${projectId}\n${subjectId}`;
// Under the server's per-request cap, so a large library imports in parts.
const IMPORT_CHUNK = 500;

async function commitInChunks(selections) {
  const totals = { created: 0, linked: 0, kept: 0 };
  for (let i = 0; i < selections.length; i += IMPORT_CHUNK) {
    const result = await commitMusicVideoCastImport(selections.slice(i, i + IMPORT_CHUNK), { silent: true });
    totals.created += result.created;
    totals.linked += result.linked;
    totals.kept += result.kept;
  }
  return totals;
}

// Why the server suggested a link (`item.match`). Exact pointers need no note.
const MATCH_NOTES = {
  name: { text: 'Same name in the catalog' },
  linked: { text: 'Linked in another video' },
  base: { text: 'Similar name, check before importing', check: true },
  'first-name': { text: 'Similar name, check before importing', check: true },
  import: { text: 'Also in another video, added once' },
};

const suggestionLabel = (item) => `Use ${item.ingredientName}${item.formLabel ? ` (${item.formLabel})` : ''}`;

// A row's choice: the server's proposal unless the director changed it. A
// record picked by hand is a link carrying its own id and name.
function ImportRow({ project, item, choice, onChange, onPick }) {
  const id = `cast-import-${project.projectId}-${item.subjectId}`;
  const kindLabel = libraryForType(item.kind)?.singular || item.kind;
  const note = item.action === 'link' && choice.action === 'link' && choice.ingredientId === item.ingredientId ? MATCH_NOTES[item.match] : null;
  return (
    <li className="flex items-center gap-3 py-2 min-w-0">
      <div className="w-12 h-16 shrink-0 rounded bg-port-bg border border-port-border overflow-hidden flex items-center justify-center">
        {item.imageId
          ? <MediaImage src={`/data/images/${item.imageId}`} alt={item.name} className="w-full h-full object-cover" loading="lazy" />
          : <Sparkles size={16} className="text-gray-600" aria-hidden="true" />}
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-sm text-white truncate">{item.name}</div>
        <div className="text-[11px] text-gray-500"><span className="capitalize">{kindLabel}</span>
          {note && <span className={note.check ? 'text-port-warning' : undefined}> · {note.text}</span>}
        </div>
      </div>
      <label htmlFor={id} className="sr-only">What to do with {item.name}</label>
      <select
        id={id}
        value={choice.action === 'link' && choice.ingredientId !== item.ingredientId ? 'picked' : choice.action}
        onChange={(e) => {
          const value = e.target.value;
          if (value === 'pick') onPick();
          else if (value === 'link') onChange({ action: 'link', ingredientId: item.ingredientId, ingredientName: item.ingredientName, formId: item.formId });
          else if (value !== 'picked') onChange({ action: value });
        }}
        className="max-w-[11rem] sm:max-w-xs bg-port-bg border border-port-border rounded px-2 py-1.5 text-sm text-white"
      >
        {item.action === 'link' && <option value="link">{suggestionLabel(item)}</option>}
        {choice.action === 'link' && choice.ingredientId !== item.ingredientId && <option value="picked">Use {choice.ingredientName}</option>}
        <option value="create">Add as new</option>
        <option value="local">Keep in this video only</option>
        <option value="pick">Use another record…</option>
      </select>
    </li>
  );
}

export default function CreativeCastImport() {
  const [projects, setProjects] = useState(null);
  const [decisions, setDecisions] = useState({});
  const [importing, setImporting] = useState(false);
  const [picking, setPicking] = useState(null);

  const load = useCallback(async (signal) => {
    const data = await previewMusicVideoCastImport({ signal, silent: true }).catch((err) => {
      if (err?.name !== 'AbortError') toast.error(err?.message || 'Could not load music video cast');
      return null;
    });
    if (signal?.aborted) return;
    setProjects(Array.isArray(data?.projects) ? data.projects : []);
    setDecisions({});
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const choiceFor = (project, item) => decisions[decisionKey(project.projectId, item.subjectId)]
    || { action: item.action, ingredientId: item.ingredientId, ingredientName: item.ingredientName, formId: item.formId };
  const setChoice = (project, item, choice) => setDecisions((d) => ({ ...d, [decisionKey(project.projectId, item.subjectId)]: choice }));
  const selections = useMemo(() => (projects || []).flatMap((project) => project.items.map((item) => {
    const choice = decisions[decisionKey(project.projectId, item.subjectId)] || item;
    const link = choice.action === 'link' ? { ingredientId: choice.ingredientId, ...(choice.formId ? { formId: choice.formId } : {}) } : {};
    return { projectId: project.projectId, subjectId: item.subjectId, action: choice.action, ...link };
  })), [projects, decisions]);
  const toCatalog = selections.filter((s) => s.action !== 'local').length;

  const handleImport = async () => {
    setImporting(true);
    const result = await commitInChunks(selections)
      .catch((err) => { toast.error(err?.message || 'Import failed'); return null; });
    setImporting(false);
    if (!result) return;
    toast.success(`Imported: ${formatCount(result.created)} new, ${formatCount(result.linked)} linked, ${formatCount(result.kept)} kept in their videos`);
    load();
  };

  return (
    // /casting/* is a full-width route, so the page owns its scroll.
    <div className="h-full overflow-y-auto p-3 sm:p-4 flex flex-col gap-3 min-w-0">
      <PageHeader
        icon={Import}
        title="Import from music videos"
        actions={(
          <Link to="/casting" className="inline-flex items-center gap-1.5 px-3 py-2 min-h-[40px] rounded-lg border border-port-border bg-port-card hover:bg-port-bg text-gray-300 hover:text-white text-sm">
            <ArrowLeft size={16} aria-hidden="true" /> Casting
          </Link>
        )}
      />
      {projects === null ? (
        <div className="flex items-center gap-2 text-sm text-gray-400"><Loader2 size={14} className="animate-spin" aria-hidden="true" /> Reading music videos…</div>
      ) : projects.length === 0 ? (
        <div className="bg-port-card border border-port-border rounded-lg p-8 text-center text-sm text-gray-400">
          Every music video&apos;s cast, sets and props are already in the catalog.
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2 bg-port-card border border-port-border rounded-lg p-3">
            <p className="text-sm text-gray-300">
              {formatCount(selections.length)} from {formatCount(projects.length)} {projects.length === 1 ? 'video' : 'videos'}. Matches to an existing record are linked, not copied.
            </p>
            <button
              type="button"
              onClick={handleImport}
              disabled={importing}
              className="inline-flex items-center gap-2 px-4 py-2 min-h-[40px] rounded-lg bg-port-accent text-white text-sm font-medium disabled:opacity-50"
            >
              {importing && <Loader2 size={14} className="animate-spin" aria-hidden="true" />}
              Import {formatCount(toCatalog)}
            </button>
          </div>
          {projects.map((project) => (
            <section key={project.projectId} aria-label={project.name} className="bg-port-card border border-port-border rounded-lg px-3 py-2 min-w-0">
              <h2 className="text-sm font-medium text-white pt-1">
                <Link to={`/music-video/${encodeURIComponent(project.projectId)}`} className="hover:text-port-accent">{project.name}</Link>
              </h2>
              <ul className="divide-y divide-port-border">
                {project.items.map((item) => (
                  <ImportRow
                    key={item.subjectId}
                    project={project}
                    item={item}
                    choice={choiceFor(project, item)}
                    onChange={(choice) => setChoice(project, item, choice)}
                    onPick={() => setPicking({ project, item })}
                  />
                ))}
              </ul>
            </section>
          ))}
        </>
      )}
      <IngredientPicker
        open={!!picking}
        type={picking?.item.kind}
        onClose={() => setPicking(null)}
        onSelect={(ingredient) => {
          if (ingredient && picking) setChoice(picking.project, picking.item, { action: 'link', ingredientId: ingredient.id, ingredientName: ingredient.name });
          setPicking(null);
        }}
      />
    </div>
  );
}
