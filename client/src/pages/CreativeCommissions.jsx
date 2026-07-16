/**
 * Creative Commissions page — the Autonomous Creation Engine index (#2657).
 *
 * A Creative Commission is a standing, recurring creative brief the server fires
 * on a schedule through the Creative Director directive pipeline. This page lists
 * every commission and hosts a deep-linked create/edit Drawer:
 *   /creative-commission        → index (list)
 *   /creative-commission/new    → create drawer
 *   /creative-commission/:id    → edit drawer (with run history)
 *
 * The URL is the source of truth for what's open, per the ID-based deep-linking
 * rule. Mutations update local state directly (no full refetch).
 */

import { useEffect, useMemo, useState, useCallback } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Plus, Sparkles, Trash2, Clock, Pause, Play } from 'lucide-react';
import toast from '../components/ui/Toast';
import Drawer from '../components/Drawer';
import ConfirmButtonPair from '../components/ui/ConfirmButtonPair';
import { timeAgo } from '../utils/formatters';
import { useConfirmDelete } from '../hooks/useConfirmDelete';
import {
  listCommissions, createCommission, updateCommission, deleteCommission,
} from '../services/api';

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// Human-readable cadence summary for the list + drawer header.
function describeSchedule(schedule) {
  if (!schedule) return 'No schedule';
  const { kind, atLocalTime, weekday, weekdaysOnly, cron } = schedule;
  if (kind === 'CUSTOM') return `Custom · ${cron || '—'}`;
  if (kind === 'WEEKLY') return `Weekly · ${WEEKDAYS[weekday] ?? '—'} at ${atLocalTime || '—'}`;
  if (kind === 'DAILY') return `Daily${weekdaysOnly ? ' (weekdays)' : ''} at ${atLocalTime || '—'}`;
  return kind || 'No schedule';
}

// A blank form is just the editable projection of an empty record.
const blankForm = () => toForm({});

// Map a stored record → editable form state (fills gaps so inputs stay controlled).
function toForm(c) {
  return {
    name: c.name || '',
    enabled: c.enabled !== false,
    targetAbility: c.targetAbility || 'video',
    brief: {
      intent: c.brief?.intent || '',
      genre: c.brief?.genre || '',
      styleSpec: c.brief?.styleSpec || '',
    },
    schedule: {
      kind: c.schedule?.kind || 'DAILY',
      atLocalTime: c.schedule?.atLocalTime || '02:00',
      weekday: Number.isInteger(c.schedule?.weekday) ? c.schedule.weekday : 0,
      weekdaysOnly: c.schedule?.weekdaysOnly === true,
      cron: c.schedule?.cron || '',
    },
    generation: {
      quality: c.generation?.quality || 'standard',
      aspectRatio: c.generation?.aspectRatio || '16:9',
      targetDurationSeconds: c.generation?.targetDurationSeconds || 10,
    },
  };
}

// Build the API payload from form state, dropping fields the schedule kind doesn't use.
function toPayload(form) {
  const s = { kind: form.schedule.kind };
  if (form.schedule.kind === 'CUSTOM') {
    s.cron = form.schedule.cron.trim();
  } else {
    s.atLocalTime = form.schedule.atLocalTime;
    if (form.schedule.kind === 'WEEKLY') s.weekday = Number(form.schedule.weekday);
    if (form.schedule.kind === 'DAILY') s.weekdaysOnly = !!form.schedule.weekdaysOnly;
  }
  return {
    name: form.name.trim(),
    enabled: !!form.enabled,
    targetAbility: form.targetAbility,
    brief: {
      intent: form.brief.intent.trim(),
      genre: form.brief.genre.trim() || null,
      styleSpec: form.brief.styleSpec,
    },
    schedule: s,
    generation: {
      quality: form.generation.quality,
      aspectRatio: form.generation.aspectRatio,
      targetDurationSeconds: Number(form.generation.targetDurationSeconds),
    },
  };
}

const inputCls = 'w-full bg-port-bg border border-port-border rounded px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-port-accent';
const labelCls = 'block text-xs font-medium text-gray-400 mb-1';

export default function CreativeCommissions() {
  const navigate = useNavigate();
  const { id } = useParams();
  const [commissions, setCommissions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState(blankForm());
  const [saving, setSaving] = useState(false);
  const { isConfirming, requestDelete, cancelDelete, confirmDelete } = useConfirmDelete();

  const drawerOpen = id != null; // '/new' or an id
  const creating = id === 'new';
  // Memoized so the O(n) lookup (and the sync effect that depends on it) only
  // recomputes when the list or target id changes — not on every keystroke.
  const editing = useMemo(
    () => (drawerOpen && !creating ? commissions.find((c) => c.id === id) || null : null),
    [drawerOpen, creating, commissions, id],
  );

  useEffect(() => {
    let cancelled = false;
    listCommissions({ silent: true })
      .then((data) => { if (!cancelled) setCommissions(Array.isArray(data) ? data : []); })
      .catch(() => { if (!cancelled) toast.error('Failed to load commissions'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  // Sync the form to the deep-linked record whenever the drawer target changes.
  useEffect(() => {
    if (creating) setForm(blankForm());
    else if (editing) setForm(toForm(editing));
  }, [id, creating, editing]);

  const closeDrawer = useCallback(() => navigate('/creative-commission'), [navigate]);

  const patchForm = (path, value) => setForm((prev) => {
    const next = { ...prev };
    if (path.length === 1) next[path[0]] = value;
    else { next[path[0]] = { ...prev[path[0]], [path[1]]: value }; }
    return next;
  });

  const handleSave = async () => {
    if (!form.name.trim()) { toast.error('Name is required'); return; }
    if (!form.brief.intent.trim()) { toast.error('Brief intent is required'); return; }
    const payload = toPayload(form);
    setSaving(true);
    try {
      if (creating) {
        const created = await createCommission(payload, { silent: true });
        setCommissions((prev) => [...prev, created]);
        toast.success('Commission created');
      } else if (editing) {
        const updated = await updateCommission(editing.id, payload, { silent: true });
        setCommissions((prev) => prev.map((c) => (c.id === updated.id ? updated : c)));
        toast.success('Commission updated');
      }
      navigate('/creative-commission');
    } catch (err) {
      toast.error(err?.message || 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (commission) => {
    const prev = commissions;
    setCommissions((cur) => cur.filter((c) => c.id !== commission.id));
    try {
      await deleteCommission(commission.id, { silent: true });
      toast.success('Commission deleted');
      if (id === commission.id) navigate('/creative-commission');
    } catch (err) {
      setCommissions(prev); // rollback
      toast.error(err?.message || 'Delete failed');
    }
  };

  const toggleEnabled = async (commission) => {
    const next = !commission.enabled;
    setCommissions((prev) => prev.map((c) => (c.id === commission.id ? { ...c, enabled: next } : c)));
    try {
      await updateCommission(commission.id, { enabled: next }, { silent: true });
    } catch (err) {
      setCommissions((prev) => prev.map((c) => (c.id === commission.id ? { ...c, enabled: commission.enabled } : c)));
      toast.error(err?.message || 'Update failed');
    }
  };

  const sorted = useMemo(
    () => [...commissions].sort((a, b) => (a.name || '').localeCompare(b.name || '')),
    [commissions],
  );

  // Deep link to a deleted/unknown id → not-found fallback (URL is source of truth).
  const notFound = drawerOpen && !creating && !editing && !loading;

  return (
    <div className="max-w-5xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <Sparkles className="w-6 h-6 text-port-accent" />
          <div>
            <h1 className="text-xl font-semibold text-gray-100">Creative Commissions</h1>
            <p className="text-sm text-gray-500">Standing briefs that create on a schedule and steer by your taste</p>
          </div>
        </div>
        <button
          onClick={() => navigate('/creative-commission/new')}
          className="flex items-center gap-2 bg-port-accent hover:bg-blue-600 text-white px-3 py-2 rounded text-sm font-medium"
        >
          <Plus className="w-4 h-4" /> New Commission
        </button>
      </div>

      {loading ? (
        <div className="text-gray-500 text-sm">Loading…</div>
      ) : sorted.length === 0 ? (
        <div className="border border-dashed border-port-border rounded-lg p-10 text-center">
          <Sparkles className="w-8 h-8 text-gray-600 mx-auto mb-3" />
          <p className="text-gray-400 mb-1">No commissions yet</p>
          <p className="text-gray-600 text-sm mb-4">
            Create a standing brief like “every night at 2am, make me something surreal” and it runs unattended.
          </p>
          <button
            onClick={() => navigate('/creative-commission/new')}
            className="inline-flex items-center gap-2 bg-port-accent hover:bg-blue-600 text-white px-3 py-2 rounded text-sm font-medium"
          >
            <Plus className="w-4 h-4" /> New Commission
          </button>
        </div>
      ) : (
        <div className="space-y-2">
          {sorted.map((c) => (
            <div
              key={c.id}
              className="flex items-center gap-3 bg-port-card border border-port-border rounded-lg p-3 hover:border-port-accent/50 transition-colors"
            >
              <button
                className="flex-1 text-left min-w-0"
                onClick={() => navigate(`/creative-commission/${encodeURIComponent(c.id)}`)}
              >
                <div className="flex items-center gap-2">
                  <span className="text-gray-100 font-medium truncate">{c.name}</span>
                  <span className={`text-[10px] uppercase px-1.5 py-0.5 rounded ${c.enabled ? 'bg-port-success/20 text-port-success' : 'bg-gray-700 text-gray-400'}`}>
                    {c.enabled ? 'Active' : 'Paused'}
                  </span>
                  <span className="text-[10px] uppercase px-1.5 py-0.5 rounded bg-port-accent/20 text-port-accent">{c.targetAbility}</span>
                </div>
                <div className="flex items-center gap-3 mt-1 text-xs text-gray-500">
                  <span className="flex items-center gap-1"><Clock className="w-3 h-3" /> {describeSchedule(c.schedule)}</span>
                  {Array.isArray(c.runs) && c.runs.length > 0 && (
                    <span>Last run {timeAgo(c.runs[c.runs.length - 1].ranAt)}</span>
                  )}
                </div>
              </button>
              <button
                onClick={() => toggleEnabled(c)}
                title={c.enabled ? 'Pause' : 'Resume'}
                className="p-2 text-gray-400 hover:text-gray-100"
              >
                {c.enabled ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
              </button>
              {isConfirming(c.id) ? (
                <ConfirmButtonPair
                  prompt="Delete?"
                  ariaLabel={`Confirm delete commission ${c.name}`}
                  onConfirm={() => confirmDelete(() => handleDelete(c))}
                  onCancel={cancelDelete}
                />
              ) : (
                <button
                  type="button"
                  onClick={() => requestDelete(c.id)}
                  title="Delete commission"
                  aria-label={`Delete commission ${c.name}`}
                  className="p-2 text-gray-400 hover:text-port-error"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {notFound && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/50" onClick={closeDrawer}>
          <div className="bg-port-card border border-port-border rounded-lg p-6 text-center" onClick={(e) => e.stopPropagation()}>
            <p className="text-gray-300 mb-3">That commission no longer exists.</p>
            <button onClick={closeDrawer} className="bg-port-accent text-white px-3 py-1.5 rounded text-sm">Back to list</button>
          </div>
        </div>
      )}

      <Drawer
        open={creating || !!editing}
        onClose={closeDrawer}
        title={creating ? 'New Commission' : 'Edit Commission'}
        subtitle={!creating && editing ? editing.name : undefined}
        size="md"
        closeOnEsc={false}
        closeOnBackdrop={false}
      >
        <CommissionForm
          form={form}
          patchForm={patchForm}
          runs={editing?.runs || []}
          saving={saving}
          onSave={handleSave}
          onCancel={closeDrawer}
        />
      </Drawer>
    </div>
  );
}

function CommissionForm({ form, patchForm, runs, saving, onSave, onCancel }) {
  // Newest-first, memoized so the copy+reverse doesn't run on every keystroke.
  const orderedRuns = useMemo(() => [...runs].reverse(), [runs]);
  return (
    <div className="space-y-5">
      {/* Identity */}
      <section className="space-y-3">
        <div>
          <label className={labelCls} htmlFor="commission-name">Name</label>
          <input
            id="commission-name"
            className={inputCls}
            value={form.name}
            maxLength={200}
            onChange={(e) => patchForm(['name'], e.target.value)}
            placeholder="Nightly Surreal"
          />
        </div>
        <label className="flex items-center gap-2 text-sm text-gray-300">
          <input
            type="checkbox"
            checked={form.enabled}
            onChange={(e) => patchForm(['enabled'], e.target.checked)}
          />
          Enabled (fires on schedule)
        </label>
      </section>

      {/* Brief */}
      <section className="space-y-3 border-t border-port-border pt-4">
        <h3 className="text-sm font-semibold text-gray-200">Brief</h3>
        <div>
          <label className={labelCls} htmlFor="commission-intent">Intent</label>
          <textarea
            id="commission-intent"
            className={`${inputCls} min-h-[70px]`}
            value={form.brief.intent}
            maxLength={2000}
            onChange={(e) => patchForm(['brief', 'intent'], e.target.value)}
            placeholder="something surreal, dreamlike, unsettlingly beautiful"
          />
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className={labelCls} htmlFor="commission-genre">Genre (optional)</label>
            <input
              id="commission-genre"
              className={inputCls}
              value={form.brief.genre}
              maxLength={120}
              onChange={(e) => patchForm(['brief', 'genre'], e.target.value)}
              placeholder="surrealism"
            />
          </div>
          <div>
            <label className={labelCls} htmlFor="commission-style">Style notes (optional)</label>
            <input
              id="commission-style"
              className={inputCls}
              value={form.brief.styleSpec}
              maxLength={5000}
              onChange={(e) => patchForm(['brief', 'styleSpec'], e.target.value)}
              placeholder="flat color, Magritte"
            />
          </div>
        </div>
      </section>

      {/* Schedule */}
      <section className="space-y-3 border-t border-port-border pt-4">
        <h3 className="text-sm font-semibold text-gray-200">Schedule</h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className={labelCls} htmlFor="commission-kind">Cadence</label>
            <select
              id="commission-kind"
              className={inputCls}
              value={form.schedule.kind}
              onChange={(e) => patchForm(['schedule', 'kind'], e.target.value)}
            >
              <option value="DAILY">Daily</option>
              <option value="WEEKLY">Weekly</option>
              <option value="CUSTOM">Custom (cron)</option>
            </select>
          </div>
          {form.schedule.kind !== 'CUSTOM' && (
            <div>
              <label className={labelCls} htmlFor="commission-time">Time (24h, local)</label>
              <input
                id="commission-time"
                type="time"
                className={inputCls}
                value={form.schedule.atLocalTime}
                onChange={(e) => patchForm(['schedule', 'atLocalTime'], e.target.value)}
              />
            </div>
          )}
          {form.schedule.kind === 'WEEKLY' && (
            <div>
              <label className={labelCls} htmlFor="commission-weekday">Day of week</label>
              <select
                id="commission-weekday"
                className={inputCls}
                value={form.schedule.weekday}
                onChange={(e) => patchForm(['schedule', 'weekday'], Number(e.target.value))}
              >
                {WEEKDAYS.map((d, i) => <option key={i} value={i}>{d}</option>)}
              </select>
            </div>
          )}
          {form.schedule.kind === 'CUSTOM' && (
            <div>
              <label className={labelCls} htmlFor="commission-cron">Cron (5-field)</label>
              <input
                id="commission-cron"
                className={inputCls}
                value={form.schedule.cron}
                maxLength={120}
                onChange={(e) => patchForm(['schedule', 'cron'], e.target.value)}
                placeholder="0 2 * * *"
              />
            </div>
          )}
        </div>
        {form.schedule.kind === 'DAILY' && (
          <label className="flex items-center gap-2 text-sm text-gray-300">
            <input
              type="checkbox"
              checked={form.schedule.weekdaysOnly}
              onChange={(e) => patchForm(['schedule', 'weekdaysOnly'], e.target.checked)}
            />
            Weekdays only (Mon–Fri)
          </label>
        )}
        <p className="text-xs text-gray-500">{describeSchedule(form.schedule)}</p>
      </section>

      {/* Generation */}
      <section className="space-y-3 border-t border-port-border pt-4">
        <h3 className="text-sm font-semibold text-gray-200">Generation (video)</h3>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div>
            <label className={labelCls} htmlFor="commission-quality">Quality</label>
            <select
              id="commission-quality"
              className={inputCls}
              value={form.generation.quality}
              onChange={(e) => patchForm(['generation', 'quality'], e.target.value)}
            >
              <option value="draft">Draft</option>
              <option value="standard">Standard</option>
              <option value="high">High</option>
            </select>
          </div>
          <div>
            <label className={labelCls} htmlFor="commission-aspect">Aspect ratio</label>
            <select
              id="commission-aspect"
              className={inputCls}
              value={form.generation.aspectRatio}
              onChange={(e) => patchForm(['generation', 'aspectRatio'], e.target.value)}
            >
              <option value="16:9">16:9</option>
              <option value="9:16">9:16</option>
              <option value="1:1">1:1</option>
            </select>
          </div>
          <div>
            <label className={labelCls} htmlFor="commission-duration">Duration (sec)</label>
            <input
              id="commission-duration"
              type="number"
              min={5}
              max={600}
              className={inputCls}
              value={form.generation.targetDurationSeconds}
              onChange={(e) => patchForm(['generation', 'targetDurationSeconds'], e.target.value)}
            />
          </div>
        </div>
      </section>

      {/* Run history (edit only) */}
      {runs.length > 0 && (
        <section className="space-y-2 border-t border-port-border pt-4">
          <h3 className="text-sm font-semibold text-gray-200">Run history</h3>
          <div className="space-y-1 max-h-52 overflow-y-auto">
            {orderedRuns.map((r) => (
              <div key={r.id} className="flex items-center justify-between text-xs bg-port-bg border border-port-border rounded px-2 py-1.5">
                <span className="text-gray-400">{timeAgo(r.ranAt)}</span>
                <span className={
                  r.status === 'started' ? 'text-port-accent'
                    : r.status === 'skipped' ? 'text-port-warning'
                      : r.status === 'failed' ? 'text-port-error' : 'text-gray-400'
                }>
                  {r.status}{r.reason ? ` · ${r.reason}` : ''}{r.error ? ` · ${r.error}` : ''}
                </span>
              </div>
            ))}
          </div>
        </section>
      )}

      <div className="flex items-center gap-2 border-t border-port-border pt-4">
        <button
          onClick={onSave}
          disabled={saving}
          className="bg-port-accent hover:bg-blue-600 disabled:opacity-50 text-white px-4 py-2 rounded text-sm font-medium"
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button onClick={onCancel} className="text-gray-400 hover:text-gray-200 px-4 py-2 text-sm">Cancel</button>
      </div>
    </div>
  );
}
