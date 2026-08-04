import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { AlertTriangle, Info, Lock, Pencil, Plus, RotateCcw, Trash2 } from 'lucide-react';
import BrailleSpinner from '../BrailleSpinner';
import Drawer from '../Drawer';
import Banner from '../ui/Banner';
import Pill from '../ui/Pill';
import ConfirmButtonPair from '../ui/ConfirmButtonPair';
import FormField from '../ui/FormField';
import toast from '../ui/Toast';
import useDrawerTab from '../../hooks/useDrawerTab';
import { NEW_SPRITE_KINDS } from '../../lib/spriteRecordGroups.js';
import {
  listSpriteAnimationTracks, createSpriteAnimationTrack,
  updateSpriteAnimationTrack, deleteSpriteAnimationTrack,
} from '../../services/apiSprites.js';

/**
 * Manage animation types (#3153) — author the user-defined half of the track
 * registry.
 *
 * #3152 made the registry a merge of the compiled `walk` row plus a JSON store, and
 * #3136 made every track's generate/review/approve workflow generic — so a new
 * animation type already renders its full workflow with no client change
 * (`TrackWorkflow.test.jsx` proves that against a synthetic `jetpack` track). This
 * drawer is the missing authoring surface: without it the store was a file the user
 * had to hand-edit.
 *
 * **The form is the row's user-facing subset, and nothing more.** The five on-disk /
 * publish-contract discriminators plus `standaloneContract` are DERIVED server-side
 * from the id, because they must be globally unique and a typo in one would hand this
 * track another's evidence chain. They're shown read-only on an existing type so a
 * collision refusal is legible rather than mysterious.
 *
 * **The server is the validator; this only front-runs it.** Bounds ordering is
 * checked here so the user sees the problem in the field, but every refusal that
 * matters (an id collision, a derived-field collision, a delete that would orphan
 * approved renders, a record kind losing its publishable baseline) comes back from
 * `assertAnimationTrackRows` as a 409 and is rendered verbatim — restating those
 * rules client-side would be a second definition that drifts.
 */

const TABS = [
  { id: 'list', label: 'Animation types' },
  { id: 'new', label: 'Add type' },
];
const TAB_IDS = TABS.map((t) => t.id);

// A new type's starting point. The kind options come from the shared
// `NEW_SPRITE_KINDS` (which already excludes the legacy import-only `props`); a
// hand-edited store row may still claim `props` and lists fine — that list and this
// default only govern the FORM.
const BLANK = {
  id: '',
  label: '',
  directional: false,
  kinds: ['object'],
  minFrameCount: 2,
  maxFrameCount: 8,
  defaultFrameCount: 4,
  minFps: 2,
  maxFps: 12,
  defaultFps: 6,
  promptTemplate: '',
};

// Mirrors the server's `TRACK_BOUND_TRIPLES` (animationTracks.js), which is the
// authoritative list — this copy exists only to name the knob in the pre-submit
// message, and the server's `assertAnimationTrackRows` is the real gate.
const BOUND_TRIPLES = [
  ['minFrameCount', 'defaultFrameCount', 'maxFrameCount', 'Frame count'],
  ['minFps', 'defaultFps', 'maxFps', 'Playback fps'],
];

// The authored subset of a registry row, as the form holds it. Mirrors the server's
// `AUTHORED_TRACK_FIELDS`; `id` rides along for the create payload and is stripped
// before a PUT (the update schema is strict and the path param owns the id).
const toForm = (row) => ({
  id: row.id,
  label: row.label,
  directional: row.directional,
  kinds: [...row.kinds],
  minFrameCount: row.minFrameCount,
  maxFrameCount: row.maxFrameCount,
  defaultFrameCount: row.defaultFrameCount,
  minFps: row.minFps,
  maxFps: row.maxFps,
  defaultFps: row.defaultFps,
  promptTemplate: row.promptTemplate || '',
});

/**
 * The first bounds problem, or `null`.
 *
 * Two rules, both chosen because the message is more useful before the round-trip
 * than after: a cleared field (the number inputs hold `''`, and `Number('')` is `0`,
 * so an emptied minimum would sail through the ordering check and come back as a raw
 * "expected number" from Zod), and the ordering the user breaks by typing a default
 * outside the range they just narrowed.
 */
function boundsError(form) {
  for (const [min, def, max, label] of BOUND_TRIPLES) {
    const values = [form[min], form[def], form[max]];
    if (values.some((v) => v === '' || v === null || !Number.isFinite(Number(v)))) {
      return `${label}: fill in the minimum, default and maximum.`;
    }
    if (!(Number(form[min]) <= Number(form[def]) && Number(form[def]) <= Number(form[max]))) {
      return `${label}: minimum ≤ default ≤ maximum is required.`;
    }
  }
  return null;
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

function formError(form, { isNew }) {
  if (isNew && !SLUG_RE.test(form.id)) {
    return 'Id must be lowercase letters, numbers and dashes, starting with a letter or number.';
  }
  if (!form.label.trim()) return 'Give the animation type a label.';
  if (!form.kinds.length) return 'Pick at least one sprite kind that may carry this type.';
  if (!form.promptTemplate.trim()) return 'A prompt template is required — it is what gets sent to the video model.';
  return boundsError(form);
}

// One input style for every field in this form, so a styling change is one edit.
const INPUT_CLASS = 'w-full px-2 py-1.5 bg-port-bg border border-port-border rounded text-sm text-white';
const LABEL_CLASS = 'block text-xs text-gray-400 mb-1';

// `FormField` owns the htmlFor/id pairing (via useId), so these need no hand-assigned
// ids — the tests still resolve each control through its label.
function NumberField({ label, value, onChange, min, max }) {
  return (
    <FormField label={label} labelClassName={LABEL_CLASS}>
      <input
        type="number"
        min={min}
        max={max}
        value={value}
        onChange={(e) => onChange(e.target.value === '' ? '' : Number(e.target.value))}
        className={INPUT_CLASS}
      />
    </FormField>
  );
}

/**
 * A row of mutually-exclusive or multi-select chips.
 *
 * The Facing and Applies-to groups were the same markup with a different active
 * predicate; sharing it puts `aria-pressed` on both rather than only one.
 */
function ToggleGroup({ label, options, isActive, onPick }) {
  return (
    <div>
      <span className={LABEL_CLASS}>{label}</span>
      <div className="flex flex-wrap gap-2">
        {options.map((option) => (
          <button
            key={String(option.value)}
            type="button"
            aria-pressed={isActive(option)}
            onClick={() => onPick(option)}
            className={`px-2.5 py-1.5 rounded text-xs border ${isActive(option)
              ? 'bg-port-accent border-port-accent text-white'
              : 'bg-port-bg border-port-border text-gray-300 hover:border-port-accent'}`}
          >
            {option.label}
            {option.hint && <span className="text-gray-400"> — {option.hint}</span>}
          </button>
        ))}
      </div>
    </div>
  );
}

const FACING_OPTIONS = [
  { value: false, label: 'One view', hint: 'renders once from the main reference' },
  { value: true, label: 'Per direction', hint: 'renders eight facings from the anchors' },
];

/**
 * The create/edit form. `track` is null for a new type.
 *
 * State is hoisted into this component rather than the Drawer body's children,
 * because the Drawer remounts its body on tab switch (`key={currentTab}`) — an
 * uncontrolled input inside would silently reset mid-edit.
 */
function TrackForm({ track, tracks, onSaved, onCancel }) {
  const isNew = !track;
  const [form, setForm] = useState(() => (track ? toForm(track) : BLANK));
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);

  // The caller remounts this component per edit target (`key`), so there is no
  // re-seed effect — the initializer above is the only place the draft is built.

  const set = (patch) => setForm((prev) => ({ ...prev, ...patch }));
  const toggleKind = (kind) => set({
    kinds: form.kinds.includes(kind) ? form.kinds.filter((k) => k !== kind) : [...form.kinds, kind],
  });

  const save = async () => {
    // Validated here rather than per render: nothing displays these, so computing
    // them on every keystroke was work for no output.
    const idTaken = isNew && form.id && tracks.some((row) => row.id === form.id);
    const problem = formError(form, { isNew })
      || (idTaken ? `'${form.id}' already exists — pick another id.` : null);
    if (problem) { setError(problem); return; }
    setSaving(true);
    setError(null);
    // Own error UI (the server's collision message is the useful one and belongs
    // beside the fields), so the API call is `{ silent: true }` per the toast
    // convention — otherwise the helper toasts and this renders it too.
    // The update schema is `.strict()` and has no `id` — the path param is the id, and
    // a rename is a delete-plus-create — so the patch must not carry one.
    const { id: _immutable, ...patch } = form;
    const result = isNew
      ? await createSpriteAnimationTrack(form, { silent: true }).catch((err) => err)
      : await updateSpriteAnimationTrack(track.id, patch, { silent: true }).catch((err) => err);
    setSaving(false);
    if (result instanceof Error) { setError(result.message || 'Save failed'); return; }
    toast.success(`${form.label} ${isNew ? 'created' : 'saved'} — restart the server to publish with it`);
    onSaved(result);
  };

  const derived = track ? {
    'Contract field': track.contractFrameCountField,
    'Review selection': track.selectionKind,
    'Finalized set': track.setKind,
  } : null;

  return (
    <div className="space-y-4">
      {isNew ? (
        <FormField
          label="Id"
          hint="Names its folder on disk; cannot be changed later."
          labelClassName={LABEL_CLASS}
        >
          <input
            type="text"
            value={form.id}
            placeholder="chest-opening"
            onChange={(e) => set({ id: e.target.value.trim().toLowerCase() })}
            className={`${INPUT_CLASS} font-mono`}
          />
        </FormField>
      ) : (
        <p className="text-xs text-gray-400">
          Editing <span className="font-mono text-gray-200">{track.id}</span>. The id is fixed — it names this
          type&apos;s folder on disk and every render&apos;s record; to rename it, delete this type and add a new one.
        </p>
      )}

      <FormField label="Label" labelClassName={LABEL_CLASS}>
        <input
          type="text"
          value={form.label}
          placeholder="Chest opening"
          onChange={(e) => set({ label: e.target.value })}
          className={INPUT_CLASS}
        />
      </FormField>

      <ToggleGroup
        label="Facing"
        options={FACING_OPTIONS}
        isActive={(option) => form.directional === option.value}
        onPick={(option) => set({ directional: option.value })}
      />

      <ToggleGroup
        label="Applies to"
        options={NEW_SPRITE_KINDS}
        isActive={(option) => form.kinds.includes(option.value)}
        onPick={(option) => toggleKind(option.value)}
      />

      <div className="grid grid-cols-3 gap-2">
        <NumberField label="Min frames" min={1} max={64} value={form.minFrameCount} onChange={(v) => set({ minFrameCount: v })} />
        <NumberField label="Default frames" min={1} max={64} value={form.defaultFrameCount} onChange={(v) => set({ defaultFrameCount: v })} />
        <NumberField label="Max frames" min={1} max={64} value={form.maxFrameCount} onChange={(v) => set({ maxFrameCount: v })} />
        <NumberField label="Min fps" min={1} max={60} value={form.minFps} onChange={(v) => set({ minFps: v })} />
        <NumberField label="Default fps" min={1} max={60} value={form.defaultFps} onChange={(v) => set({ defaultFps: v })} />
        <NumberField label="Max fps" min={1} max={60} value={form.maxFps} onChange={(v) => set({ maxFps: v })} />
      </div>

      <div>
        <FormField
          label="Prompt template"
          hint="Sent to the video model for every render."
          labelClassName={LABEL_CLASS}
        >
          <textarea
            rows={6}
            value={form.promptTemplate}
            placeholder="Animate the {{kind}} {{name}} opening once, then return to the exact starting pose. Matte on {{chromaKeyPhrase}}."
            onChange={(e) => set({ promptTemplate: e.target.value })}
            className={`${INPUT_CLASS} font-mono`}
          />
        </FormField>
        <p className="text-xs text-gray-500 mt-1">
          Placeholders: <span className="font-mono">{'{{name}}'}</span> <span className="font-mono">{'{{kind}}'}</span>{' '}
          <span className="font-mono">{'{{direction}}'}</span> <span className="font-mono">{'{{chromaKey}}'}</span>{' '}
          <span className="font-mono">{'{{chromaKeyPhrase}}'}</span>. Anything else is left as written, so a typo
          shows up in the prompt instead of vanishing.
        </p>
      </div>

      {derived && (
        <div className="border border-port-border rounded p-2 space-y-1">
          <p className="text-xs text-gray-400">
            Derived from the id — these name files on disk and the publish-contract key, so PortOS owns them:
          </p>
          {Object.entries(derived).map(([name, value]) => (
            <p key={name} className="text-xs text-gray-500">
              {name}: <span className="font-mono text-gray-300">{value}</span>
            </p>
          ))}
        </div>
      )}

      {error && <Banner tone="error" icon={AlertTriangle} size="sm">{error}</Banner>}

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={save}
          disabled={saving}
          className="px-3 py-1.5 bg-port-accent hover:bg-blue-600 disabled:opacity-50 text-white rounded text-sm"
        >
          {saving ? 'Saving…' : isNew ? 'Create type' : 'Save changes'}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="px-3 py-1.5 bg-port-bg border border-port-border hover:border-port-accent text-gray-300 rounded text-sm"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

function TrackRow({ track, onEdit, onDeleted }) {
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState(null);

  const remove = async () => {
    setDeleting(true);
    setError(null);
    // Own error UI: the server's in-use refusal names the sprites that carry
    // approved work, which is the whole point of the 409 — so `{ silent: true }`.
    const result = await deleteSpriteAnimationTrack(track.id, { silent: true }).catch((err) => err);
    setDeleting(false);
    if (result instanceof Error) { setError(result.message || 'Delete failed'); return; }
    toast.success(`${track.label} deleted`);
    onDeleted(result);
  };

  return (
    <div className="border border-port-border rounded p-3 space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-semibold text-white">{track.label}</span>
        <span className="text-xs font-mono text-gray-500">{track.id}</span>
        {track.builtin && <Pill tone="muted" icon={Lock}>Built-in</Pill>}
        {track.standaloneContract && <Pill tone="muted">Publish baseline</Pill>}
        {!track.builtin && !confirming && (
          <div className="flex items-center gap-2 ml-auto">
            <button
              type="button"
              onClick={() => onEdit(track)}
              className="flex items-center gap-1.5 px-2.5 py-1 text-xs bg-port-bg border border-port-border hover:border-port-accent text-gray-300 rounded"
            >
              <Pencil className="w-3.5 h-3.5" /> Edit
            </button>
            <button
              type="button"
              onClick={() => { setError(null); setConfirming(true); }}
              className="flex items-center gap-1.5 px-2.5 py-1 text-xs bg-port-bg border border-port-border hover:border-port-error text-gray-300 hover:text-port-error rounded"
            >
              <Trash2 className="w-3.5 h-3.5" /> Delete
            </button>
          </div>
        )}
      </div>
      <p className="text-xs text-gray-400">
        {track.directional ? 'Per direction' : 'One view'} · {track.kinds.join(', ')} ·{' '}
        {track.minFrameCount}–{track.maxFrameCount} frames (default {track.defaultFrameCount}) ·{' '}
        {track.minFps}–{track.maxFps} fps (default {track.defaultFps})
      </p>

      {confirming && (
        // Inline confirm row — the project convention (no window.confirm, and a
        // discoverable Cancel/Delete pair rather than a two-click arm).
        <div className="space-y-2 border border-port-error/40 bg-port-error/10 rounded p-2">
          <p className="text-xs text-gray-200">
            Delete <span className="font-semibold">{track.label}</span>? Sprites that already carry approved{' '}
            {track.id} renders keep those files, and the delete is refused until you reopen them.
          </p>
          {error && <Banner tone="error" size="sm">{error}</Banner>}
          <ConfirmButtonPair
            confirmIcon={Trash2}
            busy={deleting}
            busyText="Deleting"
            ariaLabel={`Confirm deleting ${track.label}`}
            onConfirm={remove}
            onCancel={() => { setConfirming(false); setError(null); }}
          />
        </div>
      )}
    </div>
  );
}

/**
 * `onClose(changed)` reports whether any type was created/edited/deleted while the
 * drawer was open, so the page only pays for its (expensive) record-detail refetch
 * when the registry actually moved — a peek-and-close costs nothing.
 */
export default function AnimationTypesDrawer({ open, onClose }) {
  const [activeTab, setActiveTab] = useDrawerTab('trackTab', 'list', TAB_IDS);
  const [searchParams, setSearchParams] = useSearchParams();
  // `null` = not loaded yet, `[]` = loaded and empty — the sentinel rule, so a
  // fetch failure or a pending load never renders as "you have no types".
  const [tracks, setTracks] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [origin, setOrigin] = useState(null);
  const [restartRequired, setRestartRequired] = useState(false);
  // Whether anything was mutated this session — a ref, not state, because nothing
  // renders from it; it only decides whether `onClose` asks the page to refetch.
  const mutatedRef = useRef(false);

  // WHICH type is being edited lives in the URL, not local state — the project's
  // "selection lives in the URL, never in local state" rule. It also removes the
  // parallel-state coordination the local version needed: `editing` is derived, so
  // there is one answer to "which form is open" instead of two kept in sync.
  const editingId = searchParams.get('editTrack');
  const editing = editingId ? tracks?.find((row) => row.id === editingId) || null : null;
  const setEditingId = useCallback((id) => {
    setSearchParams((prev) => {
      const params = new URLSearchParams(prev);
      if (id) params.set('editTrack', id);
      else params.delete('editTrack');
      return params;
    }, { replace: true });
  }, [setSearchParams]);

  const load = useCallback(async () => {
    setLoadError(null);
    const result = await listSpriteAnimationTracks({ silent: true }).catch((err) => err);
    if (result instanceof Error) { setLoadError(result.message || 'Could not load animation types'); return; }
    setTracks(result.tracks || []);
    setOrigin(result.origin || null);
  }, []);

  useEffect(() => { if (open) load(); }, [open, load]);

  // Every mutation returns the fresh table, so apply it directly instead of
  // refetching (the reactive-local-state convention).
  const applyMutation = useCallback((result) => {
    mutatedRef.current = true;
    setTracks(result.tracks || []);
    setOrigin('store');
    if (result.restartRequired) setRestartRequired(true);
    setEditingId(null);
    setActiveTab('list');
  }, [setActiveTab, setEditingId]);

  const close = useCallback(() => {
    setEditingId(null);
    onClose(mutatedRef.current);
  }, [onClose, setEditingId]);

  if (!open) return null;

  const body = () => {
    if (loadError) {
      return (
        <div className="space-y-3">
          <Banner tone="error" icon={AlertTriangle} size="sm">{loadError}</Banner>
          <button
            type="button"
            onClick={load}
            className="flex items-center gap-2 px-3 py-1.5 bg-port-bg border border-port-border hover:border-port-accent text-gray-300 rounded text-sm"
          >
            <RotateCcw className="w-4 h-4" /> Retry
          </button>
        </div>
      );
    }
    if (tracks === null) return <p className="text-sm"><BrailleSpinner text="Loading…" /></p>;

    // A stale `?editTrack=` (a shared link to a type since deleted, or a typo) must
    // say so rather than silently falling through to the blank create form, which
    // would read as "your link worked" while offering a different action — the
    // not-found fallback every id-addressed view here owes a stale id.
    if (editingId && !editing) {
      return (
        <div className="space-y-3">
          <Banner tone="warning" icon={AlertTriangle} size="sm">
            No animation type called <span className="font-mono">{editingId}</span> — it may have been deleted
            or renamed.
          </Banner>
          <button
            type="button"
            onClick={() => setEditingId(null)}
            className="flex items-center gap-2 px-3 py-1.5 bg-port-bg border border-port-border hover:border-port-accent text-gray-300 rounded text-sm"
          >
            <RotateCcw className="w-4 h-4" /> Back to the list
          </button>
        </div>
      );
    }

    if (activeTab === 'new' || editing) {
      return (
        // Remount per edit target rather than re-seeding through an effect — same
        // "load THAT row" guarantee, without the extra render.
        <TrackForm
          key={editing?.id || 'new'}
          track={editing}
          tracks={tracks}
          onSaved={applyMutation}
          onCancel={() => { setEditingId(null); setActiveTab('list'); }}
        />
      );
    }

    return (
      <div className="space-y-3">
        {restartRequired && (
          <Banner tone="warning" icon={AlertTriangle} size="sm">
            Restart the PortOS server to publish sprites with a newly-added type — its runtime-contract
            field is registered at start-up. Generating and approving renders works right away.
          </Banner>
        )}
        {origin === 'seed' && (
          <Banner tone="info" icon={Info} size="sm">
            These are the starter types PortOS ships with. Your first change writes your own copy, after
            which updates never re-add a type you deleted.
          </Banner>
        )}
        {tracks.map((track) => (
          <TrackRow
            key={track.id}
            track={track}
            onEdit={(row) => setEditingId(row.id)}
            onDeleted={applyMutation}
          />
        ))}
        <button
          type="button"
          onClick={() => setActiveTab('new')}
          className="flex items-center gap-2 px-3 py-1.5 bg-port-accent hover:bg-blue-600 text-white rounded text-sm"
        >
          <Plus className="w-4 h-4" /> Add animation type
        </button>
      </div>
    );
  };

  return (
    <Drawer
      open
      onClose={close}
      title="Animation types"
      subtitle="The sequences your sprites can be animated through"
      size="lg"
      tabs={TABS}
      activeTab={editing ? 'new' : activeTab}
      onTabChange={(id) => { setEditingId(null); setActiveTab(id); }}
      // A half-typed prompt template is real work — an Esc keystroke or a stray
      // backdrop click must not discard it.
      closeOnEsc={false}
      closeOnBackdrop={false}
      closeLabel="Close animation types"
    >
      {body()}
    </Drawer>
  );
}
