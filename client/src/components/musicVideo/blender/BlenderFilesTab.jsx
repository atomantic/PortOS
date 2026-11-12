import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { FilePlus, Save, Trash2 } from 'lucide-react';
import InlineConfirmRow from '../../ui/InlineConfirmRow';
import ListLoadError from '../../ui/ListLoadError';
import useListResource from '../../../hooks/useListResource.js';
import { useFilmApi } from './FilmApiContext.jsx';
import { BLENDER_SOURCE_PATH as SOURCE_PATH, BLENDER_TEXT_EXTENSIONS as TEXT_EXTENSIONS } from '../../../lib/musicVideoBlender.js';
import { formatBytes, formatCount } from '../../../utils/formatters.js';
import { buttonCls, inputCls, labelCls, primaryCls } from './blenderStyles.js';

export const BLENDER_FILE_PARAM = 'bfile';
const IDLE = { path: null, content: '', status: 'idle', error: null };
// A new file is never empty, so the write is a real file the editor can open.
const starterContent = (path) => (path.toLowerCase().endsWith('.json') ? '{}\n' : path.toLowerCase().endsWith('.py') ? `# src/${path}\n` : '\n');

const newPathProblem = (path, files) => {
  if (!path) return '';
  if (!SOURCE_PATH.test(path)) return 'Use letters, digits, dot, dash and underscore, with up to five folders (for example shots/s010.py).';
  if (!TEXT_EXTENSIONS.some((extension) => path.toLowerCase().endsWith(extension))) return `A new file must end in ${TEXT_EXTENSIONS.join(', ')}.`;
  if (files.some((file) => file.path === path)) return 'That file already exists. Select it in the list.';
  return '';
};

/**
 * The film's source under `src/`: every file listed (binary assets are placed
 * on disk by the operator or an agent, so they are listed only), a plain
 * monospace editor for the selected text file with explicit Save, and Delete
 * behind an inline confirm. The open file is `?bfile=<path>`. Unsaved edits
 * live in the Blender hook, so they survive leaving the tab, and hold back
 * syncs and renders until saved or discarded.
 */
export default function BlenderFilesTab({ blender }) {
  const { getMusicVideoBlenderFile, listMusicVideoBlenderFiles } = useFilmApi();
  const { projectId, pending, fileDrafts, filesRevision } = blender;
  const [searchParams, setSearchParams] = useSearchParams();
  const fetchFiles = useCallback(
    () => listMusicVideoBlenderFiles(projectId, { silent: true }).then((answer) => answer?.files || []),
    [projectId],
  );
  const files = useListResource(fetchFiles);
  const { setItems } = files;
  const sorted = files.items.slice().sort((a, b) => a.path.localeCompare(b.path));
  const requested = searchParams.get(BLENDER_FILE_PARAM);
  const file = sorted.find((entry) => entry.path === requested) || null;
  const path = file?.path || null;
  const editable = !!file?.text;
  const [loaded, setLoaded] = useState(IDLE);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [newPath, setNewPath] = useState('');
  const [readRetry, setReadRetry] = useState(0);

  // The tree changed elsewhere (an agent's write, a sync, a reconnect): re-list without blanking the list.
  const seenRevision = useRef(filesRevision);
  useEffect(() => {
    if (seenRevision.current === filesRevision) return undefined;
    seenRevision.current = filesRevision;
    let active = true;
    listMusicVideoBlenderFiles(projectId, { silent: true })
      .then((answer) => { if (active && Array.isArray(answer?.files)) setItems(answer.files); })
      // A failed refresh keeps the list already shown.
      .catch(() => {});
    return () => { active = false; };
  }, [projectId, filesRevision, setItems]);

  // The saved content of the open file; re-read when it changes on disk.
  const mtime = file?.mtime ?? null;
  useEffect(() => {
    setConfirmingDelete(false);
    if (!path || !editable) {
      setLoaded(IDLE);
      return undefined;
    }
    let active = true;
    // A re-read of the file already open keeps its text on screen while the fresh copy loads.
    setLoaded((current) => (current.path === path && current.status !== 'loading' && current.status !== 'error'
      ? { ...current, status: 'refreshing', error: null }
      : { path, content: '', status: 'loading', error: null }));
    getMusicVideoBlenderFile(projectId, path, { silent: true })
      .then((answer) => { if (active) setLoaded({ path, content: answer?.content ?? '', status: 'ready', error: null }); })
      .catch((err) => {
        if (active) setLoaded((current) => ({
          ...(current.path === path ? current : { path, content: '' }),
          status: current.path === path && (current.status === 'ready' || current.status === 'refreshing') ? 'ready' : 'error',
          error: err?.message || 'Could not read the file',
        }));
      });
    return () => { active = false; };
  }, [projectId, path, editable, mtime, readRetry]);

  const select = (next) => setSearchParams((previous) => {
    const params = new URLSearchParams(previous);
    if (next) params.set(BLENDER_FILE_PARAM, next); else params.delete(BLENDER_FILE_PARAM);
    return params;
  }, { replace: true });

  const ready = loaded.path === path && (loaded.status === 'ready' || loaded.status === 'refreshing');
  const draft = path ? fileDrafts[path] : undefined;
  const value = draft ?? loaded.content;
  const dirty = draft !== undefined && draft !== loaded.content;
  const saving = path ? !!pending[`file:${path}`] : false;
  // A draft the disk has caught up with is no longer a change, and one for a file that is gone can
  // never be saved: neither may go on holding syncs and renders back with nothing to press.
  const { discardFile } = blender;
  useEffect(() => {
    if (loaded.status === 'ready' && loaded.path === path && draft !== undefined && draft === loaded.content) discardFile(path);
  }, [loaded, path, draft, discardFile]);
  const orphanDrafts = files.state === 'ready' ? Object.keys(fileDrafts).filter((entry) => !files.items.some((item) => item.path === entry)) : [];
  const edit = (text) => {
    if (text === loaded.content) blender.discardFile(path); else blender.editFile(path, text);
  };
  const save = async () => {
    const content = value;
    const result = await blender.saveFile(path, content);
    if (result.ok) setLoaded((current) => (current.path === path ? { ...current, content } : current));
  };
  const remove = async () => {
    setConfirmingDelete(false);
    const result = await blender.deleteFile(path);
    if (!result.ok) return;
    setItems((items) => items.filter((entry) => entry.path !== path));
    select(null);
  };
  const problem = newPathProblem(newPath.trim(), files.items);
  const creating = !!pending[`file:${newPath.trim()}`];
  const create = async () => {
    const target = newPath.trim();
    if (!target || problem) return;
    const result = await blender.saveFile(target, starterContent(target));
    if (!result.ok) return;
    setItems((items) => (items.some((entry) => entry.path === target) ? items : [...items, { path: target, bytes: 0, mtime: null, text: true }]));
    setNewPath('');
    select(target);
  };

  return (
    // The container is the wrapper: a grid cannot answer a container query about itself.
    <div className="@container min-w-0">
    <div className="grid min-w-0 grid-cols-1 items-start gap-3 @2xl:grid-cols-[minmax(13rem,19rem)_minmax(0,1fr)]">
      <div className="min-w-0 space-y-2">
        {files.state === 'error' && <ListLoadError what="the source files" error={files.error} onRetry={files.retry} />}
        {files.state === 'loading' && <p role="status" className="text-xs text-port-text-muted">Loading the source files…</p>}
        {files.state === 'ready' && sorted.length === 0 && (
          <p className="text-xs text-port-text-muted">No source files yet. Create the starter workspace under Settings, or add <code className="font-mono">film.py</code> below.</p>
        )}
        {sorted.length > 0 && (
          <ul aria-label="Source files" className="max-h-[50dvh] min-w-0 divide-y divide-port-border overflow-y-auto rounded border border-port-border">
            {sorted.map((entry) => {
              const slash = entry.path.lastIndexOf('/');
              const unsaved = fileDrafts[entry.path] !== undefined;
              const label = (
                <>
                  <span className="min-w-0 flex-1 break-all font-mono text-xs">
                    {slash >= 0 && <span className="text-port-text-muted">{entry.path.slice(0, slash + 1)}</span>}
                    {entry.path.slice(slash + 1)}
                  </span>
                  {unsaved && <span className="shrink-0 text-[11px] text-port-warning">unsaved</span>}
                  <span className="shrink-0 text-[11px] text-port-text-muted">{entry.text ? formatBytes(entry.bytes) : `asset · ${formatBytes(entry.bytes)}`}</span>
                </>
              );
              return (
                <li key={entry.path}>
                  {entry.text ? (
                    <button type="button" aria-pressed={entry.path === path} onClick={() => select(entry.path)}
                      className={`flex min-h-[44px] w-full min-w-0 items-center gap-2 px-2 py-1.5 text-left hover:bg-port-bg focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-port-accent pointer-fine:sm:min-h-0 ${entry.path === path ? 'bg-port-accent/10' : ''}`}>
                      {label}
                    </button>
                  ) : (
                    <div className="flex min-w-0 items-center gap-2 px-2 py-1.5" title="A binary asset: placed on disk, listed here, not editable">{label}</div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {orphanDrafts.map((entry) => (
          <p key={entry} role="status" className="flex min-w-0 flex-wrap items-center gap-x-2 text-xs text-port-warning">
            <span className="min-w-0 break-all">Unsaved edits to src/{entry}, which is no longer in the workspace.</span>
            <button type="button" className={buttonCls} onClick={() => blender.discardFile(entry)}>Discard</button>
          </p>
        ))}
        <div className="min-w-0 space-y-1">
          <label htmlFor="mv-blender-new-file" className={labelCls}>New text file under src/</label>
          <div className="flex min-w-0 items-center gap-1.5">
            <input id="mv-blender-new-file" value={newPath} onChange={(event) => setNewPath(event.target.value)} placeholder="shots/s010.py" spellCheck={false}
              autoCapitalize="off" autoCorrect="off" aria-invalid={problem ? true : undefined} aria-describedby={problem ? 'mv-blender-new-file-problem' : undefined}
              className={`${inputCls} font-mono`} />
            <button type="button" className={`${buttonCls} shrink-0`} disabled={!newPath.trim() || !!problem || creating || files.state !== 'ready'} onClick={create}>
              <FilePlus size={14} aria-hidden="true" /> {creating ? 'Creating…' : 'Create'}
            </button>
          </div>
          {problem && <p id="mv-blender-new-file-problem" role="alert" className="text-xs text-port-error">{problem}</p>}
        </div>
      </div>

      <div className="min-w-0 space-y-2">
        {requested && files.state === 'ready' && !file && (
          <p role="status" className="text-xs text-port-warning">src/{requested} is not in the workspace any more. Pick a file from the list.</p>
        )}
        {file && !editable && <p className="text-xs text-port-text-muted">src/{file.path} is a binary asset. It is used by the film but cannot be edited here.</p>}
        {!file && !requested && <p className="text-xs text-port-text-muted">Select a text file to read or edit it. Saving writes it to the workspace; nothing runs until you sync or render.</p>}
        {file && editable && (
          <>
            <div className="flex min-w-0 flex-wrap items-center gap-1.5">
              <label htmlFor="mv-blender-file-editor" className="min-w-0 flex-1 break-all font-mono text-xs">src/{path}</label>
              {dirty && <span role="status" className="text-xs text-port-warning">Unsaved changes</span>}
              <button type="button" className={primaryCls} disabled={!dirty || saving || !ready} onClick={save}>
                <Save size={14} aria-hidden="true" /> {saving ? 'Saving…' : 'Save'}
              </button>
              {dirty && !saving && <button type="button" className={buttonCls} onClick={() => blender.discardFile(path)}>Discard</button>}
              <button type="button" className={buttonCls} disabled={saving || confirmingDelete} onClick={() => setConfirmingDelete(true)}>
                <Trash2 size={14} aria-hidden="true" /> Delete
              </button>
            </div>
            {confirmingDelete && (
              <InlineConfirmRow
                autoFocus
                aria-label={`Confirm deleting src/${path}`}
                question={`Delete src/${path}? This removes it from the workspace.`}
                onConfirm={remove}
                onCancel={() => setConfirmingDelete(false)}
              />
            )}
            {loaded.error && loaded.path === path && <ListLoadError what={`src/${path}`} error={{ message: loaded.error }} onRetry={() => setReadRetry((count) => count + 1)} />}
            {loaded.status !== 'error' && (
              <textarea id="mv-blender-file-editor" value={value} disabled={!ready || saving} spellCheck={false} autoCapitalize="off" autoCorrect="off" wrap="off"
                onChange={(event) => edit(event.target.value)}
                className="h-[55dvh] min-h-[16rem] w-full min-w-0 resize-y rounded border border-port-border bg-port-bg p-2 font-mono text-xs leading-5 focus:outline-none focus:ring-2 focus:ring-port-accent disabled:opacity-60" />
            )}
            <p className="text-[11px] text-port-text-muted">
              {!ready && loaded.status !== 'error' ? 'Loading…' : `${formatCount(value.split('\n').length)} lines · ${formatBytes(file.bytes)} on disk`}
            </p>
          </>
        )}
      </div>
    </div>
    </div>
  );
}
