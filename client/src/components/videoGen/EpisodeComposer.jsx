/**
 * Episode Composer (#6228) — write or import a rough multi-scene episode
 * script, preview it as chained continuous-video clips with live lint status
 * (#6226's hard-cut/slot-lock rules), then queue it for generation over the
 * continuous-video orchestrator (#6227).
 *
 * The live preview is a debounced POST to `/api/continuous-video/lint` —
 * compose+lint without submitting — rather than a client-side port of the
 * compiler/linter, since `composeEpisodeClips` pulls in server-only imports
 * (fs paths, SSE registry) that can't ship to the browser.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  CheckCircle2, XCircle, Loader2, Plus, Trash2, Sparkles, Film,
} from 'lucide-react';
import {
  lintContinuousVideoEpisode, generateContinuousVideoEpisode, continuousVideoEpisodeEventsUrl,
} from '../../services/api';
import { useSseProgress } from '../../hooks/useSseProgress';
import { useAsyncAction } from '../../hooks/useAsyncAction';
import toast from '../ui/Toast';
import { uuidv4 } from '../../lib/uuid.js';

const CONTINUOUS_VIDEO_BACKENDS = ['local', 'reactor', 'fal'];
const PREVIEW_DEBOUNCE_MS = 500;

// `sceneIndex:beatIndex` is a stable clip identity across recompiles — the
// raw array index is not: editing an earlier scene's beat count reflows
// every downstream clip's position, which would silently reattach an
// already-entered camera framing to the wrong beat.
const clipFramingKey = (clip) => `${clip.sceneIndex}:${clip.beatIndex}`;
const framingsArrayFor = (clips, framings) => (clips || []).map((clip) => framings[clipFramingKey(clip)] || null);

const emptyLine = () => ({ key: uuidv4(), type: 'action', speaker: '', voice: '', text: '' });
const emptyScene = () => ({ key: uuidv4(), sceneId: uuidv4(), location: '', lines: [emptyLine()] });

/** Strip UI-only keys and empty lines/scenes before this goes over the wire. */
function sanitizeScenesForRequest(scenes) {
  return scenes
    .map((scene) => ({
      sceneId: scene.sceneId || undefined,
      location: scene.location.trim() || undefined,
      lines: scene.lines
        .filter((l) => l.text.trim())
        .map((l) => ({
          type: l.type,
          ...(l.type === 'dialogue' && l.speaker.trim() ? { speaker: l.speaker.trim() } : {}),
          ...(l.type === 'dialogue' && l.voice.trim() ? { voice: l.voice.trim() } : {}),
          text: l.text.trim(),
        })),
    }))
    .filter((scene) => scene.lines.length > 0);
}

function buildBible(styleDescriptor, castEntries, locationEntries) {
  const bible = {};
  if (styleDescriptor.trim()) bible.styleDescriptor = styleDescriptor.trim();
  const cast = {};
  castEntries.forEach((e) => { if (e.id.trim() && e.descriptor.trim()) cast[e.id.trim()] = { descriptor: e.descriptor.trim() }; });
  if (Object.keys(cast).length) bible.cast = cast;
  const locations = {};
  locationEntries.forEach((e) => { if (e.id.trim() && e.descriptor.trim()) locations[e.id.trim()] = { descriptor: e.descriptor.trim() }; });
  if (Object.keys(locations).length) bible.locations = locations;
  return bible;
}

function BibleEntryEditor({ label, entries, onChange, idPlaceholder, busy }) {
  // `key` is a stable React identity separate from `id` (the editable bible
  // key) — entries need identity before the user has typed a real id.
  const update = (i, patch) => onChange(entries.map((e, idx) => (idx === i ? { ...e, ...patch } : e)));
  const remove = (i) => onChange(entries.filter((_, idx) => idx !== i));
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-medium text-gray-400">{label}</span>
        <button type="button" disabled={busy} onClick={() => onChange([...entries, { key: uuidv4(), id: '', descriptor: '' }])} className="inline-flex items-center gap-1 text-[11px] text-port-accent hover:underline disabled:opacity-50">
          <Plus className="w-3 h-3" /> Add
        </button>
      </div>
      {entries.map((entry, i) => (
        <div key={entry.key} className="flex gap-1.5 items-start">
          <input
            type="text" value={entry.id} disabled={busy} onChange={(e) => update(i, { id: e.target.value })}
            placeholder={idPlaceholder} aria-label={`${label} id`}
            className="w-28 shrink-0 bg-port-bg border border-port-border rounded px-2 py-1 text-xs text-white focus:outline-none focus:border-port-accent disabled:opacity-50"
          />
          <input
            type="text" value={entry.descriptor} disabled={busy} onChange={(e) => update(i, { descriptor: e.target.value })}
            placeholder="byte-stable visual descriptor" aria-label={`${label} descriptor`}
            className="flex-1 bg-port-bg border border-port-border rounded px-2 py-1 text-xs text-white focus:outline-none focus:border-port-accent disabled:opacity-50"
          />
          <button type="button" onClick={() => remove(i)} disabled={busy} aria-label={`Remove ${label} entry`} className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center p-1 text-gray-500 hover:text-port-error disabled:opacity-50">
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      ))}
    </div>
  );
}

function SceneEditor({ scene, onChange, onRemove, busy }) {
  const updateLine = (i, patch) => onChange({ ...scene, lines: scene.lines.map((l, idx) => (idx === i ? { ...l, ...patch } : l)) });
  const addLine = () => onChange({ ...scene, lines: [...scene.lines, emptyLine()] });
  const removeLine = (i) => onChange({ ...scene, lines: scene.lines.filter((_, idx) => idx !== i) });
  return (
    <div className="border border-port-border/50 rounded-lg p-2.5 space-y-2">
      <div className="flex items-center gap-1.5">
        <label htmlFor={`scene-location-${scene.key}`} className="sr-only">Scene location id</label>
        <input
          id={`scene-location-${scene.key}`} type="text" value={scene.location}
          onChange={(e) => onChange({ ...scene, location: e.target.value })}
          disabled={busy} placeholder="location id (matches a Locations bible entry)"
          className="flex-1 bg-port-bg border border-port-border rounded px-2 py-1 text-xs text-white focus:outline-none focus:border-port-accent disabled:opacity-50"
        />
        <button type="button" onClick={onRemove} disabled={busy} aria-label="Remove scene" className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center p-1 text-gray-500 hover:text-port-error disabled:opacity-50">
          <Trash2 className="w-3.5 h-3.5" />
        </button>
      </div>
      <div className="space-y-1.5">
        {scene.lines.map((line, i) => (
          <div key={line.key} className="flex gap-1.5 items-start">
            <select
              value={line.type} onChange={(e) => updateLine(i, { type: e.target.value })} disabled={busy}
              aria-label="Line type"
              className="w-20 shrink-0 bg-port-bg border border-port-border rounded px-1.5 py-1 text-xs text-white focus:outline-none focus:border-port-accent disabled:opacity-50"
            >
              <option value="action">Action</option>
              <option value="dialogue">Dialogue</option>
            </select>
            {line.type === 'dialogue' && (
              <input
                type="text" value={line.speaker} onChange={(e) => updateLine(i, { speaker: e.target.value })}
                disabled={busy} placeholder="speaker id" aria-label="Speaker id"
                className="w-24 shrink-0 bg-port-bg border border-port-border rounded px-2 py-1 text-xs text-white focus:outline-none focus:border-port-accent disabled:opacity-50"
              />
            )}
            <input
              type="text" value={line.text} onChange={(e) => updateLine(i, { text: e.target.value })}
              disabled={busy} placeholder={line.type === 'dialogue' ? 'what they say' : 'what happens'} aria-label="Line text"
              className="flex-1 bg-port-bg border border-port-border rounded px-2 py-1 text-xs text-white focus:outline-none focus:border-port-accent disabled:opacity-50"
            />
            <button type="button" onClick={() => removeLine(i)} disabled={busy} aria-label="Remove line" className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center p-1 text-gray-500 hover:text-port-error disabled:opacity-50">
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          </div>
        ))}
      </div>
      <button type="button" onClick={addLine} disabled={busy} className="inline-flex items-center gap-1 text-[11px] text-port-accent hover:underline disabled:opacity-50">
        <Plus className="w-3 h-3" /> Add line
      </button>
    </div>
  );
}

function ClipPreviewCard({ clip, result, framing, onFramingChange, busy }) {
  const pass = result?.pass !== false;
  return (
    <div className={`border rounded-lg p-2.5 space-y-1.5 ${pass ? 'border-port-border/50' : 'border-port-error/60'}`}>
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="text-[10px] font-mono text-gray-500">#{result?.index ?? 0}</span>
          <span className={`text-[10px] px-1.5 py-0.5 rounded ${clip.cutType === 'continue' ? 'bg-purple-500/20 text-purple-300' : 'bg-blue-500/20 text-blue-300'}`}>
            {clip.cutType === 'continue' ? 'continue' : 'fresh cut'}
          </span>
          {clip.speakers?.map((s) => (
            <span key={s} className="text-[10px] px-1.5 py-0.5 rounded bg-port-border/50 text-gray-300">{s}</span>
          ))}
        </div>
        {pass ? (
          <CheckCircle2 className="w-4 h-4 text-port-success shrink-0" aria-label="Lint passed" />
        ) : (
          <XCircle className="w-4 h-4 text-port-error shrink-0" aria-label="Lint failed" />
        )}
      </div>
      <p className="text-[11px] text-gray-400 line-clamp-3">{clip.prompt}</p>
      {clip.references?.length > 0 && (
        <div className="flex items-center gap-1 flex-wrap text-[10px] text-gray-500">
          <span>slot locks:</span>
          {clip.references.map((r) => <span key={`${r.kind}/${r.id}`} className="font-mono">{r.kind}/{r.id}</span>)}
        </div>
      )}
      {clip.cutType === 'continue' && (
        <div className="flex items-center gap-1.5">
          <label htmlFor={`framing-${clipFramingKey(clip)}`} className="text-[11px] text-gray-400 shrink-0">Camera framing</label>
          <input
            id={`framing-${clipFramingKey(clip)}`} type="text" value={framing} disabled={busy}
            onChange={(e) => onFramingChange(e.target.value)}
            placeholder="e.g. close-up on Mara's face"
            className="flex-1 bg-port-bg border border-port-border rounded px-2 py-1 text-[11px] text-white focus:outline-none focus:border-port-accent disabled:opacity-50"
          />
        </div>
      )}
      {!pass && (
        <ul className="text-[10px] text-port-error space-y-0.5 list-disc list-inside">
          {result.reasons.map((r) => <li key={r}>{r}</li>)}
        </ul>
      )}
    </div>
  );
}

const scenesFromImport = (imported) => imported.map((s) => ({
  key: uuidv4(), sceneId: s.sceneId || uuidv4(), location: s.location || '',
  lines: s.lines.map((l) => ({ key: uuidv4(), type: l.type, speaker: l.speaker || '', voice: l.voice || '', text: l.text || '' })),
}));

export default function EpisodeComposer({ initialScenes, onQueued }) {
  const [scenes, setScenes] = useState(() => (initialScenes?.length ? scenesFromImport(initialScenes) : [emptyScene()]));
  const [styleDescriptor, setStyleDescriptor] = useState('');
  const [castEntries, setCastEntries] = useState([]);
  const [locationEntries, setLocationEntries] = useState([]);
  const [backend, setBackend] = useState('local');
  const [framings, setFramings] = useState({}); // { [`${sceneIndex}:${beatIndex}`]: string }
  const [preview, setPreview] = useState(null); // { clips, lint }
  const [previewLoading, setPreviewLoading] = useState(false);
  const [queuedJobId, setQueuedJobId] = useState(null);
  const debounceRef = useRef(null);
  const previewRequestRef = useRef(0);

  // `initialScenes` starts null and arrives later once VideoGen's FableLoom
  // import fetch resolves (EpisodeComposer is already mounted by then, so the
  // lazy useState initializer above never sees it) — apply it the one time it
  // transitions from empty to populated, without clobbering user edits after.
  const importAppliedRef = useRef(!!initialScenes?.length);
  useEffect(() => {
    if (importAppliedRef.current || !initialScenes?.length) return;
    importAppliedRef.current = true;
    setScenes(scenesFromImport(initialScenes));
  }, [initialScenes]);

  const bible = useMemo(() => buildBible(styleDescriptor, castEntries, locationEntries), [styleDescriptor, castEntries, locationEntries]);
  const sanitizedScenes = useMemo(() => sanitizeScenesForRequest(scenes), [scenes]);
  const hasContent = sanitizedScenes.length > 0;

  const sse = useSseProgress(queuedJobId ? continuousVideoEpisodeEventsUrl(queuedJobId) : null);

  // Debounced live preview — recompiles + relints on every scene/bible/framing
  // edit. Skipped once queued: the composer is read-only during generation.
  // `sanitizedScenes`/`bible` are already fresh-only-on-change via useMemo, so
  // depending on them directly (no JSON.stringify) is both cheaper and correct.
  useEffect(() => {
    if (queuedJobId) return undefined;
    if (!hasContent) { setPreview(null); setPreviewLoading(false); return undefined; }
    setPreviewLoading(true);
    const requestId = (previewRequestRef.current += 1);
    debounceRef.current = setTimeout(async () => {
      const result = await lintContinuousVideoEpisode({
        scenes: sanitizedScenes, bible, framings: framingsArrayFor(preview?.clips, framings),
      }).catch(() => null);
      // A newer edit may have started a later request while this one was in
      // flight — a slower earlier response must not overwrite it.
      if (requestId !== previewRequestRef.current) return;
      setPreview(result);
      setPreviewLoading(false);
    }, PREVIEW_DEBOUNCE_MS);
    return () => clearTimeout(debounceRef.current);
    // Re-runs on any scene/bible/framing edit; `preview` itself is excluded to
    // avoid retriggering off its own write.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sanitizedScenes, bible, framings, queuedJobId]);

  useEffect(() => {
    if (sse.latest?.type === 'complete') {
      toast.success('Episode generated');
      onQueued?.(sse.latest.result);
    } else if (sse.latest?.type === 'error') {
      toast.error(sse.latest.error?.message || sse.latest.error || 'Episode generation failed');
    }
  }, [sse.latest, onQueued]);

  const [handleQueue, queuing] = useAsyncAction(async () => {
    const result = await generateContinuousVideoEpisode({
      scenes: sanitizedScenes, bible, framings: framingsArrayFor(preview.clips, framings), backend,
    }, { silent: true }); // useAsyncAction owns the error toast
    setQueuedJobId(result.jobId);
  }, { errorMessage: 'Failed to queue episode' });

  // `!previewLoading` matters: without it, editing a passing draft into a
  // failing one leaves the OLD passing preview (and its stale `preview.clips`)
  // queueable until the new lint resolves — Queue would fire against
  // in-flight-stale scenes and the server would 422 on a lint the UI never
  // showed as failing.
  const canQueue = hasContent && !previewLoading && preview?.lint?.pass === true && !queuing && !queuedJobId;

  const resetForNewEpisode = () => {
    setQueuedJobId(null);
    setScenes([emptyScene()]);
    setFramings({});
    setPreview(null);
  };

  const streaming = !!queuedJobId && !sse.closed;
  const busy = queuing || streaming;

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <label htmlFor="episode-style-descriptor" className="text-[11px] font-medium text-gray-400 block">Style descriptor</label>
        <input
          id="episode-style-descriptor" type="text" value={styleDescriptor} disabled={busy}
          onChange={(e) => setStyleDescriptor(e.target.value)}
          placeholder="e.g. gritty 35mm noir, high contrast"
          className="w-full bg-port-bg border border-port-border rounded px-2 py-1.5 text-xs text-white focus:outline-none focus:border-port-accent disabled:opacity-50"
        />
      </div>

      <BibleEntryEditor label="Cast" entries={castEntries} onChange={setCastEntries} idPlaceholder="mara" busy={busy} />
      <BibleEntryEditor label="Locations" entries={locationEntries} onChange={setLocationEntries} idPlaceholder="cell-block" busy={busy} />

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-[11px] font-medium text-gray-400">Scenes</span>
          <button type="button" disabled={busy} onClick={() => setScenes((prev) => [...prev, emptyScene()])} className="inline-flex items-center gap-1 text-[11px] text-port-accent hover:underline disabled:opacity-50">
            <Plus className="w-3 h-3" /> Add scene
          </button>
        </div>
        {scenes.map((scene, i) => (
          <SceneEditor
            key={scene.key} scene={scene} busy={busy}
            onChange={(next) => setScenes((prev) => prev.map((s, idx) => (idx === i ? next : s)))}
            onRemove={() => setScenes((prev) => prev.filter((_, idx) => idx !== i))}
          />
        ))}
      </div>

      <div className="flex items-center gap-2">
        <label htmlFor="episode-backend" className="text-[11px] font-medium text-gray-400 shrink-0">Backend</label>
        <select
          id="episode-backend" value={backend} disabled={busy} onChange={(e) => setBackend(e.target.value)}
          className="bg-port-bg border border-port-border rounded px-2 py-1 text-xs text-white focus:outline-none focus:border-port-accent disabled:opacity-50"
        >
          {CONTINUOUS_VIDEO_BACKENDS.map((b) => <option key={b} value={b}>{b}</option>)}
        </select>
      </div>

      <div className="space-y-2">
        <div className="flex items-center gap-1.5 text-[11px] font-medium text-gray-400">
          <Sparkles className="w-3.5 h-3.5" /> Beat preview
          {previewLoading && <Loader2 className="w-3 h-3 animate-spin" />}
        </div>
        {!hasContent && <p className="text-[11px] text-gray-500">Write at least one scene to see a beat preview.</p>}
        {preview?.clips?.map((clip, i) => (
          <ClipPreviewCard
            key={clipFramingKey(clip)} clip={clip} result={preview.lint?.results?.[i]} busy={busy}
            framing={framings[clipFramingKey(clip)] || ''}
            onFramingChange={(v) => setFramings((prev) => ({ ...prev, [clipFramingKey(clip)]: v }))}
          />
        ))}
      </div>

      {queuedJobId ? (
        <div className="border border-port-border/50 rounded-lg p-2.5 space-y-1.5">
          <div className="flex items-center gap-1.5 text-xs text-gray-300">
            <Film className="w-3.5 h-3.5" />
            {streaming ? (sse.latest?.message || 'Generating…') : 'Episode generation finished'}
          </div>
          {typeof sse.latest?.progress === 'number' && (
            <div className="w-full h-1.5 bg-port-border rounded overflow-hidden">
              <div className="h-full bg-port-accent" style={{ width: `${Math.round(sse.latest.progress * 100)}%` }} />
            </div>
          )}
          {!streaming && (
            <button type="button" onClick={resetForNewEpisode} className="text-[11px] text-port-accent hover:underline">
              Compose another episode
            </button>
          )}
        </div>
      ) : (
        <button
          type="button" onClick={handleQueue} disabled={!canQueue}
          className="w-full min-h-[44px] inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded bg-port-accent text-white text-sm font-medium disabled:opacity-40"
        >
          {queuing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Film className="w-4 h-4" />}
          Queue episode
        </button>
      )}
    </div>
  );
}
