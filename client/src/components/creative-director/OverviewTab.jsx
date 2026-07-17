import { Link } from 'react-router-dom';
import { useState, useEffect, useRef } from 'react';
import { Sparkles, Loader2 } from 'lucide-react';
import { updateCreativeDirectorProject, applyCreativeDirectorAutoCast } from '../../services/apiCreativeDirector.js';
import { selectProjectPreview, previewAspectClass } from '../../lib/creativeDirectorPreview.js';
import MediaImage from '../MediaImage.jsx';
import ScenePreview from './ScenePreview.jsx';
import toast from '../ui/Toast';

export default function OverviewTab({ project, onProjectUpdate, onAsyncWorkQueued }) {
  const [disableAudio, setDisableAudio] = useState(project.disableAudio === true);
  const [saving, setSaving] = useState(false);
  const [autoCasting, setAutoCasting] = useState(false);
  // Auto-compose (#1817): when checked, auto-cast also hands the seeded cast to
  // the treatment agent so the director writes a first-pass treatment + scene
  // plan. Director-first — off by default so the user opts into the autonomy.
  const [composeAfter, setComposeAfter] = useState(false);
  // First-pass gen (#1818): when checked, auto-cast also enqueues a catalog
  // portrait render for each newly-cast member lacking one, so the cast arrives
  // on-model. Off by default — opt into the autonomy. Independent of compose:
  // portraits are useful with or without an auto-written treatment.
  const [generateFirstPass, setGenerateFirstPass] = useState(false);
  // First-pass music bed (#1928, split from #1867): when checked, auto-cast
  // also enqueues a background music-bed render for the project itself. Off by
  // default — opt into the autonomy. Independent of the other toggles: there's
  // no "newly-cast member" requirement, so it's offered even on a re-cast.
  const [generateFirstPassMusicBed, setGenerateFirstPassMusicBed] = useState(false);
  // Track the project id this tab is currently mounted for. If the user
  // toggles audio and navigates to a different CD project before the PATCH
  // resolves, the late `.then()` would otherwise call onProjectUpdate on
  // the now-different project and silently overwrite its local state.
  // We also reset `saving` on project switch — otherwise the new project
  // inherits the stuck-true flag (the prior project's PATCH cleanup is
  // gated on the old id and never runs the .finally for this instance),
  // leaving the new project's audio checkbox permanently disabled.
  const projectIdRef = useRef(project.id);
  // Guards prop-driven resets while a PATCH is in flight. A stale poll
  // response arriving before the PATCH resolves would otherwise call
  // setSaving(false) and roll back the optimistic toggle.
  const savingRef = useRef(false);
  useEffect(() => {
    projectIdRef.current = project.id;
    setDisableAudio(project.disableAudio === true);
    setSaving(false);
    savingRef.current = false;
    // Reset auto-cast spinner on project switch too — its .finally gates on the
    // id matching, so without this a same-instance project swap could strand the
    // flag (defensive; the parent currently remounts on id change).
    setAutoCasting(false);
    // The compose toggle is a per-project intent — don't carry it across a switch.
    setComposeAfter(false);
    // First-pass toggle is per-project intent too — reset on switch.
    setGenerateFirstPass(false);
    // First-pass music-bed toggle is per-project intent too — reset on switch.
    setGenerateFirstPassMusicBed(false);
  }, [project.id]);
  useEffect(() => {
    if (!savingRef.current) {
      setDisableAudio(project.disableAudio === true);
    }
  }, [project.disableAudio]);

  const handleAudioToggle = (e) => {
    const next = e.target.checked;
    setDisableAudio(next);
    setSaving(true);
    savingRef.current = true;
    const requestProjectId = project.id;
    updateCreativeDirectorProject(requestProjectId, { disableAudio: next })
      .then(() => {
        if (projectIdRef.current === requestProjectId) {
          onProjectUpdate?.({ disableAudio: next });
        }
      })
      .catch((err) => {
        if (projectIdRef.current === requestProjectId) {
          setDisableAudio(!next);
        }
        toast.error(err.message || 'Failed to update audio setting');
      })
      .finally(() => {
        savingRef.current = false;
        if (projectIdRef.current === requestProjectId) {
          setSaving(false);
        }
      });
  };
  // Autonomous auto-cast (#1810): the director queries the catalog from the
  // project's brief and APPENDS the fresh matches to the cast. Guarded against a
  // project switch mid-request so the result lands on the project that asked.
  const handleAutoCast = () => {
    setAutoCasting(true);
    const requestProjectId = project.id;
    // Only ask the server to compose when there's no treatment yet — the server
    // guards this too, but gating here keeps the toast honest. Omit the flag
    // entirely in the default case so the request body stays minimal.
    const wantCompose = composeAfter && !project.treatment;
    applyCreativeDirectorAutoCast(
      requestProjectId,
      {
        ...(wantCompose ? { compose: true } : {}),
        ...(generateFirstPass ? { generateFirstPass: true } : {}),
        ...(generateFirstPassMusicBed ? { generateFirstPassMusicBed: true } : {}),
      },
      { silent: true },
    )
      .then((result) => {
        if (projectIdRef.current !== requestProjectId) return;
        const added = result?.added?.length || 0;
        const composing = Boolean(result?.composing);
        const firstPassQueued = result?.firstPass?.enqueued?.length || 0;
        const musicBedQueued = Boolean(result?.firstPassMusicBed?.enqueued);
        // The music-bed render is a single background `audio` media job — hand its
        // id up so the detail page can watch `audio-gen:*` and toast a failure the
        // user would otherwise only find by polling the Render Queue (#1933).
        const musicBedJobId = result?.firstPassMusicBed?.jobId || null;
        // When the director starts composing, optimistically flip the status to
        // 'planning' as well — the detail page disables polling for 'draft'
        // projects, so without this the treatment + runs the agent produces stay
        // invisible until a manual refresh. The 5s poll re-corrects if needed.
        onProjectUpdate?.({
          cast: result?.project?.cast || [],
          ...(composing ? { status: 'planning' } : {}),
        });
        // Portraits land on a catalog ingredient (no project-status change to
        // ride), and the music bed lands on `project.musicBed` directly — both
        // attach asynchronously, well after this response. A project that
        // hasn't been started/composed yet stays at status 'draft', which the
        // detail page's poll gate treats as terminal (no compose flip to
        // escape it, unlike the `composing` branch above). Tell the parent to
        // extend polling for a bit so either result actually shows up in the
        // open tab instead of requiring a manual Refresh / navigate-away.
        if (firstPassQueued > 0 || musicBedQueued) onAsyncWorkQueued?.({ musicBedJobId });
        // Suffix the portrait-gen count + music-bed status onto whichever
        // success toast fires, so a user who opted into either first-pass gen
        // sees it kicked off in one place.
        const portraitSuffix = firstPassQueued > 0
          ? ` — rendering ${firstPassQueued} first-pass portrait${firstPassQueued === 1 ? '' : 's'}`
          : '';
        const musicBedSuffix = musicBedQueued ? ' + a first-pass music bed' : '';
        if (composing) {
          toast.success(`Auto-cast added ${added} ingredient${added === 1 ? '' : 's'} — director is composing the treatment…${portraitSuffix}${musicBedSuffix}`);
        } else if (added > 0) {
          toast.success(`Auto-cast added ${added} ingredient${added === 1 ? '' : 's'}${portraitSuffix}${musicBedSuffix}`);
        } else if (musicBedQueued) {
          toast.success(`Auto-cast found no new catalog matches for this brief${musicBedSuffix}`);
        } else {
          toast.info('Auto-cast found no new catalog matches for this brief');
        }
      })
      .catch((err) => toast.error(err.message || 'Auto-cast failed'))
      .finally(() => {
        if (projectIdRef.current === requestProjectId) setAutoCasting(false);
      });
  };

  const collectionLink = `/media/collections/${project.collectionId}`;
  const final = project.finalVideoId
    ? <Link to={`/media/history?selected=${project.finalVideoId}`} className="text-port-accent">{project.finalVideoId}</Link>
    : <span className="text-port-text-muted">not yet rendered</span>;

  // Inline render of the produced media (#2702). The final cut is the only thing
  // this section claims to show — a mid-production scene render deliberately
  // does NOT surface here (the Segments tab already previews those, and framing
  // one as the deliverable would misrepresent an unfinished project). A
  // directive plan that emits images rather than video shows its produced image
  // instead. When nothing is produced the section is omitted entirely, so the
  // configuration stays above the fold and the "not yet rendered" copy on the
  // Final video field remains the single honest signal.
  const preview = selectProjectPreview(project);
  const aspectClass = previewAspectClass(project.aspectRatio);
  const inlineImage = !project.finalVideoId && preview.kind === 'image' ? preview : null;

  return (
    <div className="space-y-4 max-w-3xl">
      {(project.finalVideoId || inlineImage) && (
        <section className="bg-port-card border border-port-border rounded p-4 space-y-2">
          <h2 className="text-sm font-semibold text-port-text-muted uppercase tracking-wide">
            {project.finalVideoId ? 'Final video' : inlineImage.label}
          </h2>
          <div className={`${aspectClass} rounded overflow-hidden bg-port-bg max-h-[60vh] mx-auto`}>
            {project.finalVideoId
              ? <ScenePreview jobId={project.finalVideoId} label="Final video" aspectClass={aspectClass} />
              : (
                <MediaImage
                  src={inlineImage.src}
                  alt={`${inlineImage.label} — ${project.name || 'project'}`}
                  className="w-full h-full object-contain"
                />
              )}
          </div>
          {project.finalVideoId && (
            <Link to={`/media/history?selected=${project.finalVideoId}`} className="text-port-accent text-xs">
              Open in Media History
            </Link>
          )}
        </section>
      )}

      <section className="bg-port-card border border-port-border rounded p-4 space-y-2">
        <h2 className="text-sm font-semibold text-port-text-muted uppercase tracking-wide">Configuration</h2>
        <Field label="Aspect ratio" value={project.aspectRatio} />
        <Field label="Quality" value={project.quality} />
        <Field label="Model" value={project.modelId} />
        <Field label="Target duration" value={`${project.targetDurationSeconds}s (~${Math.round(project.targetDurationSeconds / 60)} min)`} />
        <Field label="Starting image" value={project.startingImageFile || '—'} />
        <div className="grid grid-cols-3 gap-2 text-sm">
          <div className="text-port-text-muted">Audio</div>
          <div className="col-span-2">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={disableAudio}
                onChange={handleAudioToggle}
                disabled={saving}
                className="accent-port-accent"
              />
              <span className="text-port-text">Disable audio</span>
            </label>
            <div className="text-xs text-port-text-muted mt-1">
              Applies to future scene renders only — already-rendered scenes keep their original audio.
            </div>
          </div>
        </div>
        <Field label="Collection" value={project.collectionId ? <Link to={collectionLink} className="text-port-accent">{project.collectionId}</Link> : <span className="text-port-text-muted">—</span>} />
        {project.musicBed?.filename && (
          <Field
            label="Music bed"
            value={`${project.musicBed.filename}${project.musicBed.durationSec ? ` (${Math.round(project.musicBed.durationSec)}s, ${project.musicBed.engine || 'audio-gen'})` : ''}`}
          />
        )}
        <Field label="Final video" value={final} />
        {project.timelineProjectId && (
          <Field label="Timeline" value={<Link to={`/media/timeline/${project.timelineProjectId}`} className="text-port-accent">{project.timelineProjectId}</Link>} />
        )}
      </section>

      {project.styleSpec && (
        <section className="bg-port-card border border-port-border rounded p-4">
          <h2 className="text-sm font-semibold text-port-text-muted uppercase tracking-wide mb-2">Style spec</h2>
          <pre className="whitespace-pre-wrap text-sm text-port-text font-mono">{project.styleSpec}</pre>
        </section>
      )}

      {project.userStory && (
        <section className="bg-port-card border border-port-border rounded p-4">
          <h2 className="text-sm font-semibold text-port-text-muted uppercase tracking-wide mb-2">User-supplied story</h2>
          <pre className="whitespace-pre-wrap text-sm text-port-text font-mono">{project.userStory}</pre>
        </section>
      )}

      <section className="bg-port-card border border-port-border rounded p-4">
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-sm font-semibold text-port-text-muted uppercase tracking-wide">
            Cast ({Array.isArray(project.cast) ? project.cast.length : 0})
          </h2>
          {/* Autonomous auto-cast (#1810): seed the cast from the catalog without
              hand-picking. Disabled with no brief to search on. The compose
              toggle (#1817) chains the treatment agent after seeding — only
              offered while there's no treatment yet (it can't clobber one). */}
          <div className="flex items-center gap-2">
            {!project.treatment && (
              <label
                htmlFor="cd-compose-after"
                className="flex items-center gap-1 text-xs text-port-text-muted cursor-pointer"
                title="After seeding the cast, let the director write a first-pass treatment + scene plan grounded in it"
              >
                <input
                  id="cd-compose-after"
                  type="checkbox"
                  checked={composeAfter}
                  onChange={(e) => setComposeAfter(e.target.checked)}
                  disabled={autoCasting}
                  className="accent-port-accent"
                />
                <span>+ treatment</span>
              </label>
            )}
            {/* First-pass gen (#1818): render an on-model portrait for each
                newly-cast member lacking one. Independent of the treatment
                toggle, so it's always offered alongside auto-cast. */}
            <label
              htmlFor="cd-first-pass"
              className="flex items-center gap-1 text-xs text-port-text-muted cursor-pointer"
              title="After seeding the cast, queue a catalog portrait render for each new member that has no portrait yet"
            >
              <input
                id="cd-first-pass"
                type="checkbox"
                checked={generateFirstPass}
                onChange={(e) => setGenerateFirstPass(e.target.checked)}
                disabled={autoCasting}
                className="accent-port-accent"
              />
              <span>+ portraits</span>
            </label>
            {/* First-pass music bed (#1928, split from #1867): enqueue a
                background music-bed render for the project itself. No
                catalog ingredient to attach to, so the result lands on
                project.musicBed via a durable server-side hook instead. */}
            <label
              htmlFor="cd-first-pass-music-bed"
              className="flex items-center gap-1 text-xs text-port-text-muted cursor-pointer"
              title="After seeding the cast, queue a first-pass music-bed render for the project (local audio-gen only)"
            >
              <input
                id="cd-first-pass-music-bed"
                type="checkbox"
                checked={generateFirstPassMusicBed}
                onChange={(e) => setGenerateFirstPassMusicBed(e.target.checked)}
                disabled={autoCasting}
                className="accent-port-accent"
              />
              <span>+ music bed</span>
            </label>
            <button
              type="button"
              onClick={handleAutoCast}
              disabled={autoCasting || !hasSearchableBrief(project)}
              title={hasSearchableBrief(project)
                ? 'Let the director pick catalog ingredients from this project’s brief'
                : 'Add a style spec or story first — auto-cast searches the catalog from the project brief'}
              className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded border border-port-border text-port-text hover:border-port-accent disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {autoCasting
                ? <Loader2 size={12} className="animate-spin" aria-hidden="true" />
                : <Sparkles size={12} aria-hidden="true" />}
              {autoCasting ? 'Auto-casting…' : 'Auto-cast'}
            </button>
          </div>
        </div>
        <p className="text-xs text-port-text-muted mb-2">
          Catalog ingredients remixed into this project — the director grounds the treatment and per-scene casting on them. Auto-cast appends new matches; you can always edit the result.
        </p>
        {Array.isArray(project.cast) && project.cast.length > 0 ? (
          <div className="flex flex-col gap-1.5">
            {project.cast.map((member) => {
              // Ingredient detail route is /catalog/:type/:id (matches CatalogCard);
              // fall back to a non-link span if the cast member is missing its type.
              const detailPath = member.type
                ? `/catalog/${encodeURIComponent(member.type)}/${encodeURIComponent(member.ingredientId)}`
                : null;
              return (
                <div key={member.ingredientId} className="text-sm">
                  {detailPath
                    ? <Link to={detailPath} className="text-port-accent font-medium">{member.name}</Link>
                    : <span className="text-port-text font-medium">{member.name}</span>}
                  {(member.type || member.role) && (
                    <span className="text-port-text-muted"> · {[member.type, member.role].filter(Boolean).join(' · ')}</span>
                  )}
                  {member.summary && <span className="text-port-text-muted">: {member.summary}</span>}
                </div>
              );
            })}
          </div>
        ) : (
          <p className="text-sm text-port-text-muted italic">
            No cast yet — use Auto-cast to pull matching catalog ingredients, or remix them in from the Catalog.
          </p>
        )}
      </section>

      {project.failureReason && (
        <section className="bg-port-card border border-port-error rounded p-4">
          <h2 className="text-sm font-semibold text-port-error uppercase tracking-wide mb-2">Failure reason</h2>
          <p className="text-sm text-port-text break-all">{project.failureReason}</p>
        </section>
      )}
    </div>
  );
}

// True when the project carries enough authored brief (style spec or user story)
// to be worth an auto-cast search. The server also folds in the project name, but
// a name alone is low signal — so the UI only offers auto-cast once there's a real
// brief to match catalog ingredients against.
function hasSearchableBrief(project) {
  return Boolean(
    (typeof project?.styleSpec === 'string' && project.styleSpec.trim())
    || (typeof project?.userStory === 'string' && project.userStory.trim()),
  );
}

function Field({ label, value }) {
  return (
    <div className="grid grid-cols-3 gap-2 text-sm">
      <div className="text-port-text-muted">{label}</div>
      <div className="col-span-2 text-port-text break-all">{value}</div>
    </div>
  );
}
