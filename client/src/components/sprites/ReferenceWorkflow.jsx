import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Lock, Sparkles, RefreshCw, Upload, ChevronDown, ChevronRight,
  Images, PersonStanding, GitFork, X,
} from 'lucide-react';
import toast from '../ui/Toast';
import { generateSpriteReference, lockSpriteReference, updateSpriteRecord } from '../../services/apiSprites.js';
import { useAsyncAction } from '../../hooks/useAsyncAction.js';
import SpritePreview from './SpritePreview.jsx';
import GalleryImagePicker from '../imageGen/GalleryImagePicker.jsx';
import SpriteReferencePicker from './SpriteReferencePicker.jsx';
import ForkSpriteModal from './ForkSpriteModal.jsx';

// Reference workflow (issue #2896): generate main-reference candidates from
// text + optional uploaded design image, freeze the approved main, then
// derive + lock the 8 directional anchors. The manifest (server-owned) is the
// source of truth for status; this component only renders it and fires the
// generate/lock/override actions.

// Mirrors server/services/sprites/chromaKey.js CHROMA_KEYS (client can't
// import server modules).
const CHROMA_KEYS = ['#FF00FF', '#00FF00', '#0000FF'];

// Thin alias so the existing call sites keep their `className` semantics
// (sizing on the box) while the checkerboard + pixelation rules live in one
// place — see SpritePreview.
function SpriteImg({ recordId, path, className }) {
  return <SpritePreview recordId={recordId} path={path} className={className} />;
}

// Candidate thumbnail with an inline lock confirm (locking is irreversible —
// per the repo's confirmation UX convention this is an inline confirm row,
// not a browser dialog or a hidden two-click arm).
function CandidateTile({ recordId, candidate, locking, onLock, clipRisk }) {
  const [confirming, setConfirming] = useState(false);
  return (
    <div className="bg-port-bg border border-port-border rounded p-1 space-y-1">
      <SpriteImg recordId={recordId} path={candidate.path} className="w-full h-24 object-contain" />
      <p className="text-[10px] text-gray-500 truncate" title={candidate.path}>
        {candidate.path.split('/').pop()}{candidate.mode ? ` · ${candidate.mode}` : ''}
      </p>
      {clipRisk ? (
        <div className="space-y-1 text-[10px]">
          <p className="text-port-warning">{clipRisk}</p>
          <button
            onClick={() => onLock(candidate, true)}
            disabled={locking}
            className="w-full px-1.5 py-0.5 text-xs bg-port-warning/20 border border-port-warning rounded text-port-warning disabled:opacity-50"
          >
            Lock anyway
          </button>
        </div>
      ) : confirming ? (
        <div className="flex items-center gap-1 text-xs">
          <span className="text-port-warning">Freeze forever?</span>
          <button onClick={() => { setConfirming(false); onLock(candidate); }} disabled={locking} className="px-1.5 py-0.5 bg-port-accent text-white rounded disabled:opacity-50">Lock</button>
          <button onClick={() => setConfirming(false)} className="px-1.5 py-0.5 text-gray-400 hover:text-white">Cancel</button>
        </div>
      ) : (
        <button
          onClick={() => setConfirming(true)}
          disabled={locking}
          className="flex items-center gap-1 w-full justify-center px-1.5 py-0.5 text-xs bg-port-card border border-port-border rounded text-gray-300 hover:border-port-accent disabled:opacity-50"
        >
          <Lock className="w-3 h-3" /> Lock
        </button>
      )}
    </div>
  );
}

export default function ReferenceWorkflow({ record, reference, renders, backends, mode, onModeChange, onChanged, onForked }) {
  const recordId = record.id;
  const manifest = reference?.manifest || null;
  const candidates = reference?.candidates || [];
  const mainLocked = manifest?.mainReference?.locked === true;
  // Once every anchor is locked this grid is just static previews of files the
  // "Reference set" file browser below already lists (and makes inspectable /
  // downloadable), so it reads as duplicate content. Collapse it by default
  // when complete — the grid stays the authoritative surface WHILE you're
  // generating/locking, and the browser stays the one place to inspect the
  // frozen files. Toggle re-arms per character; a mid-session lock leaves the
  // grid as the user left it.
  const anchorList = manifest?.anchors || [];
  const allAnchorsLocked = anchorList.length > 0 && anchorList.every((a) => a.status === 'locked');
  const [anchorsOpen, setAnchorsOpen] = useState(!allAnchorsLocked);
  // Reset the default on record switch only (deps: recordId), so it never
  // fights a user toggle within one character.
  useEffect(() => { setAnchorsOpen(!allAnchorsLocked); }, [recordId]);

  // Image-backend availability + the selected `mode` are page-owned (#2938) so
  // that the Sprites page's asset-card Regenerate re-rolls through the SAME
  // backend this picker drives (a per-component fetch would let the two
  // diverge). `backends`: null = settings not loaded yet; [] = loaded, no
  // backend configured.
  const [designPrompt, setDesignPrompt] = useState(manifest?.designPrompt || '');
  // The main render can be seeded (image+text→image) from one of three sources:
  // an uploaded file, a pick from the render-history gallery, or another sprite's
  // locked main reference. One unified `refSource` holds whichever is active so
  // the generate payload and the preview stay in sync.
  //   null | { type:'upload', file, previewUrl }
  //        | { type:'gallery', filename, previewUrl, label }
  //        | { type:'sprite', id, name, path }
  const [refSource, setRefSource] = useState(null);
  const [strength, setStrength] = useState(0.65);
  const [galleryOpen, setGalleryOpen] = useState(false);
  const [spritePickerOpen, setSpritePickerOpen] = useState(false);
  const [forkOpen, setForkOpen] = useState(false);
  const fileInputRef = useRef(null);

  // Revoke the previous upload's object URL whenever the source changes or the
  // component unmounts (cleanup runs with the prior closure).
  useEffect(() => {
    const url = refSource?.type === 'upload' ? refSource.previewUrl : null;
    return () => { if (url) URL.revokeObjectURL(url); };
  }, [refSource]);

  const clearSource = () => {
    setRefSource(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };
  const pickUpload = (file) => {
    if (!file) return;
    setRefSource({ type: 'upload', file, previewUrl: URL.createObjectURL(file) });
  };
  // target → jobId for in-flight renders. Owned by the Sprites page and shared
  // with the asset collection's anchor Regenerate buttons (#2931) so both gate
  // on one map — see the matching note in WalkWorkflow.
  const { pendingJobs, beginSubmit, resolveSubmit, cancelSubmit } = renders;

  const candidatesByTarget = useMemo(() => candidates.reduce((acc, c) => {
    const t = c.target || 'main';
    (acc[t] ||= []).push(c);
    return acc;
  }, {}), [candidates]);

  const generate = async (target) => {
    beginSubmit(target);
    try {
      const { jobId } = await generateSpriteReference(recordId, {
        target,
        ...(mode ? { mode } : {}),
        ...(target === 'main' ? {
          designPrompt,
          ...(refSource?.type === 'upload' ? { referenceImageFile: refSource.file } : {}),
          ...(refSource?.type === 'gallery' ? { initImageGalleryFile: refSource.filename } : {}),
          ...(refSource?.type === 'sprite' ? { initImageSpriteId: refSource.id } : {}),
          ...(refSource ? { initImageStrength: strength } : {}),
        } : {}),
      }, { silent: true });
      resolveSubmit(target, jobId);
      if (target === 'main') clearSource();
    } catch (err) {
      cancelSubmit(target);
      toast.error(err?.message || `Failed to queue ${target} render`);
    }
  };

  // path → clip-risk message; a risky main lock 409s until the user
  // explicitly locks through it from the candidate tile.
  const [clipRisks, setClipRisks] = useState({});

  const [lock, locking] = useAsyncAction(async (target, candidate, acceptClipRisk = false) => {
    try {
      await lockSpriteReference(recordId, {
        target, candidate: candidate.path, ...(acceptClipRisk ? { acceptClipRisk: true } : {}),
      }, { silent: true });
    } catch (err) {
      if (err?.code === 'CHROMA_CLIP_RISK') {
        setClipRisks((prev) => ({ ...prev, [candidate.path]: err.message }));
        return;
      }
      throw err; // useAsyncAction toasts
    }
    setClipRisks((prev) => {
      const next = { ...prev };
      delete next[candidate.path];
      return next;
    });
    toast.success(target === 'main' ? 'Main reference frozen' : `Anchor ${target} locked`);
    onChanged();
  }, { errorMessage: 'Lock failed' });

  const [setChromaKey, keySaving] = useAsyncAction(async (hex) => {
    await updateSpriteRecord(recordId, { chromaKey: hex }, { silent: true });
    // A key change invalidates any clip-risk warning the user was shown —
    // force a fresh 409/confirm cycle instead of letting a stale "Lock
    // anyway" accept a risk computed for the old key.
    setClipRisks({});
    onChanged();
  }, { errorMessage: 'Failed to set chroma key' });

  const noBackend = Array.isArray(backends) && backends.length === 0;
  const modePicker = Array.isArray(backends) && backends.length > 0 && (
    <label className="flex items-center gap-2 text-xs text-gray-400">
      Backend
      <select
        value={mode}
        onChange={(e) => onModeChange(e.target.value)}
        className="bg-port-bg border border-port-border rounded px-2 py-1 text-sm text-white"
      >
        {backends.map((b) => <option key={b.id} value={b.id}>{b.label || b.id}</option>)}
      </select>
    </label>
  );

  return (
    <div className="bg-port-card border border-port-border rounded-lg p-4 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-white flex items-center gap-1.5">
          <Sparkles className="w-4 h-4" /> Reference Set
          <span className="text-xs font-normal text-gray-500">{manifest?.status || 'not started'}</span>
        </h3>
        <div
          className="flex items-center gap-1.5"
          title={mainLocked
            ? 'Chroma key is frozen with the locked reference set'
            : 'Chroma key — auto-selected at main lock; pin one of the three standard keys, or auto to let the lock decide'}
        >
          <span className="text-xs text-gray-500">key</span>
          <button
            onClick={() => setChromaKey(null)}
            disabled={keySaving || mainLocked}
            className={`px-1.5 h-5 rounded-sm border text-[10px] ${!record.chromaKey ? 'border-white ring-1 ring-port-accent text-white' : 'border-port-border text-gray-400 opacity-60 hover:opacity-100'} disabled:opacity-40`}
          >
            auto
          </button>
          {CHROMA_KEYS.map((hex) => (
            <button
              key={hex}
              onClick={() => setChromaKey(hex)}
              disabled={keySaving || mainLocked}
              aria-label={`Set chroma key ${hex}`}
              className={`w-5 h-5 rounded-sm border ${record.chromaKey === hex ? 'border-white ring-1 ring-port-accent' : 'border-port-border opacity-60 hover:opacity-100'} disabled:opacity-40`}
              style={{ backgroundColor: hex }}
            />
          ))}
        </div>
      </div>
      {manifest?.chromaKeyWarning && (
        <p className="text-xs text-port-warning">{manifest.chromaKeyWarning}</p>
      )}
      {noBackend && (
        <p className="text-xs text-port-warning">
          No image backend configured — enable Codex or Grok, or set a local Python path, in Settings → Image Gen to generate references.
        </p>
      )}

      {/* Main reference — the immutable identity root */}
      <div className="space-y-2">
        <h4 className="text-xs uppercase tracking-wide text-gray-500">Main reference (walk-south)</h4>
        {mainLocked ? (
          <div className="flex items-start gap-3">
            <SpriteImg recordId={recordId} path={manifest.mainReference.path} className="w-32 h-32 object-contain bg-port-bg border border-port-border rounded" />
            <div className="space-y-2">
              <p className="text-xs text-gray-500 flex items-center gap-1"><Lock className="w-3 h-3" /> frozen · immutable root</p>
              {/* A locked main can never be regenerated — to iterate on it, fork
                  into a new character seeded from this reference (image+text→image). */}
              <button
                type="button"
                onClick={() => setForkOpen(true)}
                className="flex items-center gap-1.5 px-2.5 py-1 text-xs bg-port-card border border-port-border rounded text-gray-300 hover:border-port-accent"
              >
                <GitFork className="w-3.5 h-3.5" /> Fork from this reference
              </button>
            </div>
          </div>
        ) : (
          <div className="space-y-2">
            <textarea
              value={designPrompt}
              onChange={(e) => setDesignPrompt(e.target.value)}
              placeholder="Describe the character (or attach a design reference image)…"
              rows={2}
              className="w-full bg-port-bg border border-port-border rounded px-3 py-1.5 text-sm text-white"
            />
            {/* Reference image (optional, i2i seed) — pick ONE of three sources.
                Hidden file input driven by the Upload button. */}
            <input
              ref={fileInputRef}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              className="hidden"
              onChange={(e) => pickUpload(e.target.files?.[0] || null)}
            />
            {refSource ? (
              <div className="flex items-center gap-3 bg-port-bg border border-port-border rounded p-2">
                {refSource.type === 'sprite' ? (
                  <SpriteImg recordId={refSource.id} path={refSource.path} className="w-14 h-14 object-contain shrink-0" />
                ) : (
                  <img src={refSource.previewUrl} alt="reference" className="w-14 h-14 object-contain rounded shrink-0" />
                )}
                <div className="min-w-0 flex-1">
                  <p className="text-xs text-gray-300 truncate">
                    {refSource.type === 'upload' ? refSource.file.name
                      : refSource.type === 'gallery' ? (refSource.label || 'gallery image')
                        : refSource.name}
                  </p>
                  <p className="text-[10px] text-gray-500">
                    {refSource.type === 'upload' ? 'uploaded image'
                      : refSource.type === 'gallery' ? 'from render history'
                        : 'from reference sprite'}
                  </p>
                  <label className="mt-1 flex items-center gap-2 text-[10px] text-gray-500">
                    fidelity
                    <input
                      type="range" min="0" max="1" step="0.05" value={strength}
                      onChange={(e) => setStrength(Number(e.target.value))}
                      className="accent-port-accent"
                      aria-label="Reference fidelity"
                    />
                    <span className="tabular-nums w-8">{strength.toFixed(2)}</span>
                  </label>
                </div>
                <button
                  type="button"
                  onClick={clearSource}
                  aria-label="Remove reference image"
                  className="p-1 text-gray-400 hover:text-white shrink-0"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            ) : (
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs text-gray-500">Reference image (optional):</span>
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="flex items-center gap-1.5 px-2.5 py-1 text-xs bg-port-card border border-port-border rounded text-gray-300 hover:border-port-accent"
                >
                  <Upload className="w-3.5 h-3.5" /> Upload
                </button>
                <button
                  type="button"
                  onClick={() => setGalleryOpen(true)}
                  className="flex items-center gap-1.5 px-2.5 py-1 text-xs bg-port-card border border-port-border rounded text-gray-300 hover:border-port-accent"
                >
                  <Images className="w-3.5 h-3.5" /> From history
                </button>
                <button
                  type="button"
                  onClick={() => setSpritePickerOpen(true)}
                  className="flex items-center gap-1.5 px-2.5 py-1 text-xs bg-port-card border border-port-border rounded text-gray-300 hover:border-port-accent"
                >
                  <PersonStanding className="w-3.5 h-3.5" /> From sprite
                </button>
              </div>
            )}
            <div className="flex flex-wrap items-center gap-3">
              {modePicker}
              <button
                onClick={() => generate('main')}
                disabled={!mode || !!pendingJobs.main || (!designPrompt.trim() && !refSource)}
                className="flex items-center gap-1.5 px-3 py-1 bg-port-accent hover:bg-blue-600 disabled:opacity-50 text-white rounded text-sm"
              >
                {pendingJobs.main ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
                {pendingJobs.main ? 'Rendering…' : 'Generate candidate'}
              </button>
            </div>
            {(candidatesByTarget.main || []).length > 0 && (
              <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-2">
                {candidatesByTarget.main.map((c) => (
                  <CandidateTile key={c.path} recordId={recordId} candidate={c} locking={locking} clipRisk={clipRisks[c.path]} onLock={(cand, accept) => lock('main', cand, accept)} />
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Directional anchors — derive from the frozen main */}
      {mainLocked && (
        <div className="space-y-2">
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => setAnchorsOpen((o) => !o)}
              aria-expanded={anchorsOpen}
              className="flex items-center gap-1 text-xs uppercase tracking-wide text-gray-500 hover:text-gray-300"
            >
              {anchorsOpen ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
              Directional anchors
              {allAnchorsLocked && (
                <span className="text-[10px] text-port-success normal-case tracking-normal flex items-center gap-0.5">
                  · <Lock className="w-2.5 h-2.5" /> all locked
                </span>
              )}
            </button>
            {anchorsOpen && modePicker}
          </div>
          {!anchorsOpen && allAnchorsLocked && (
            <p className="text-[10px] text-gray-600">Locked anchors are listed under “Reference set” below.</p>
          )}
          {anchorsOpen && (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {manifest.anchors.map((anchor) => (
              <div key={anchor.id} className="bg-port-bg border border-port-border rounded p-2 space-y-1.5">
                <p className="text-xs text-gray-400 flex items-center justify-between">
                  {anchor.direction}
                  {anchor.status === 'locked' && <Lock className="w-3 h-3 text-port-success" />}
                </p>
                {anchor.status === 'locked' ? (
                  <SpriteImg recordId={recordId} path={anchor.path} className="w-full h-24 object-contain" />
                ) : (
                  <div className="space-y-1.5">
                    <button
                      onClick={() => generate(anchor.direction)}
                      disabled={!mode || !!pendingJobs[anchor.direction]}
                      className="flex items-center gap-1 w-full justify-center px-2 py-1 text-xs bg-port-card border border-port-border rounded text-gray-300 hover:border-port-accent disabled:opacity-50"
                    >
                      {pendingJobs[anchor.direction]
                        ? <><RefreshCw className="w-3 h-3 animate-spin" /> Rendering…</>
                        : <><Sparkles className="w-3 h-3" /> Generate</>}
                    </button>
                    {(candidatesByTarget[anchor.direction] || []).map((c) => (
                      <CandidateTile key={c.path} recordId={recordId} candidate={c} locking={locking} clipRisk={clipRisks[c.path]} onLock={(cand, accept) => lock(anchor.direction, cand, accept)} />
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
          )}
        </div>
      )}

      {/* Reference-image source pickers + fork. Portal-based modals, so their
          placement in the tree doesn't matter. */}
      <GalleryImagePicker
        open={galleryOpen}
        onClose={() => setGalleryOpen(false)}
        onSelect={(item) => setRefSource({
          type: 'gallery', filename: item.filename, previewUrl: item.previewUrl, label: item.prompt || item.filename,
        })}
      />
      <SpriteReferencePicker
        open={spritePickerOpen}
        onClose={() => setSpritePickerOpen(false)}
        excludeId={recordId}
        onSelect={(it) => setRefSource({ type: 'sprite', id: it.id, name: it.name, path: it.path })}
      />
      {mainLocked && (
        <ForkSpriteModal
          open={forkOpen}
          onClose={() => setForkOpen(false)}
          source={{ id: recordId, name: record.name }}
          referencePath={manifest.mainReference.path}
          backends={backends}
          mode={mode}
          onForked={(rec) => onForked?.(rec)}
        />
      )}
    </div>
  );
}
