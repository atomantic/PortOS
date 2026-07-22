import { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Sword, Star, Moon, ScrollText, Heart, UserRound, Cake, AlertTriangle,
  Sparkles, RefreshCw, Dices, X, ChevronDown, Zap, Image, Activity
} from 'lucide-react';
import { birthDateCta } from '../utils/characterXp';
import BrailleSpinner from '../components/BrailleSpinner';
import PageSkeleton from '../components/ui/PageSkeleton';
import GoalsCard from '../components/character/GoalsCard';
import toast from '../components/ui/Toast';
import { timeAgo, formatCompactCount } from '../utils/formatters';
import api, { generateAvatar } from '../services/api';
import socket from '../services/socket';
import { clickableProps } from '../lib/a11yKeyboard.js';

// Silent by default — every caller owns its own error UI (a catch-block toast,
// or the loadError banner in load()), so the request() helper must not also
// toast or the user sees a double error (issue #2520). Callers can still opt
// back into the helper toast by passing { silent: false }.
const charGet = (options = {}) => api.get('/character', { silent: true, ...options });
const charPost = (path, body, options = {}) => api.post(`/character${path}`, body, { silent: true, ...options });
const charPut = (body, options = {}) => api.put('/character', body, { silent: true, ...options });

const EVENT_ICONS = {
  damage: Sword,
  xp: Star,
  rest: Moon,
  level_up: Sparkles,
  custom: ScrollText,
  sync: RefreshCw
};

const EVENT_COLORS = {
  damage: 'text-port-error',
  xp: 'text-port-warning',
  rest: 'text-port-accent',
  level_up: 'text-port-accent-2',
  custom: 'text-gray-400',
  sync: 'text-port-accent'
};

function hpColor(pct) {
  if (pct > 50) return 'bg-port-success';
  if (pct > 25) return 'bg-port-warning';
  return 'bg-port-error';
}

// Per-domain skills derived on read from each domain's existing stats (#2674). Deliberately
// a plain read-only card: Slice 5 (#2677) owns the page's framing/redesign, so this stays
// easy to restyle or relocate wholesale.
//
// `unavailable` renders as an explicit "—" rather than a 0: the server distinguishes an
// untouched domain (a real level 0) from one whose stat could not be read, and collapsing
// those here would re-introduce the exact lie the server's sentinel exists to prevent.
function SkillsCard({ skills }) {
  if (!skills?.length) return null;

  return (
    <section aria-labelledby="character-skills-heading" className="bg-port-card border border-port-border rounded-xl p-4">
      <div className="flex items-center gap-1.5 mb-3">
        <Zap className="w-4 h-4 text-port-accent-2" />
        <h2 id="character-skills-heading" className="text-sm font-medium text-gray-300">Skills</h2>
        <span className="text-xs text-gray-500">— earned by using PortOS</span>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
        {skills.map((skill) => (
          <div key={skill.id} className="bg-port-bg border border-port-border rounded-lg px-3 py-2">
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-sm text-gray-300 truncate">{skill.label}</span>
              {skill.unavailable ? (
                <span className="text-sm text-gray-600" title="This domain's stats could not be read">—</span>
              ) : (
                <span className="text-sm font-semibold text-port-accent-2">Lv {skill.level}</span>
              )}
            </div>
            <div className="text-xs text-gray-500 mt-0.5">
              {skill.unavailable ? 'Unavailable' : `${skill.value} logged`}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

// Render one metric's value per its server-declared `unit`. Only unbounded COUNTS go through
// formatCompactCount, so a 12,400-memory Brain reads "12.4K" instead of overflowing the tile;
// day counts stay literal (a 1200-day streak is "1200d", not a nonsense "1.2Kd") and percents
// are 0-100 by construction. Only called for tiles with a real numeric value — the null
// states are handled by the caller.
//
// Deliberately page-local rather than hoisted into utils/formatters.js: it defines no new
// number formatting (it dispatches to the shared formatter), and it is coupled to the metric
// payload shape that characterMetrics.js owns — so it belongs with the card that renders it,
// which Slice 5 (#2677) will restyle or relocate wholesale. Exported only for its unit test.
export function formatMetricValue({ unit, value }) {
  if (unit === 'percent') return `${value}%`;
  if (unit === 'days') return `${value}d`;
  return formatCompactCount(value);
}

// Engagement metrics derived on read from the same domain signals that power the skills
// (#2676). Like SkillsCard this is deliberately a plain read-only card — Slice 5 (#2677) owns
// the page's framing/redesign, so it stays easy to restyle or relocate wholesale.
//
// THREE states per tile, never two (mirroring the server's sentinels):
//   - unavailable   → "Unavailable" and an em dash. The stat could not be read.
//   - notApplicable → the metric's own emptyLabel ("No goals resolved yet"). No honest number
//                     exists yet — and 0 is emphatically not it for a ratio.
//   - a real value  → the number, INCLUDING a real 0.
// Collapsing any of these into a fake 0 would re-introduce the exact lie the server's
// sentinels exist to prevent.
function MetricsCard({ metrics }) {
  if (!metrics?.length) return null;

  return (
    <section aria-labelledby="character-metrics-heading" className="bg-port-card border border-port-border rounded-xl p-4">
      <div className="flex items-center gap-1.5 mb-3">
        <Activity className="w-4 h-4 text-port-accent" />
        <h2 id="character-metrics-heading" className="text-sm font-medium text-gray-300">Metrics</h2>
        <span className="text-xs text-gray-500">— your real activity</span>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
        {metrics.map((metric) => (
          <div key={metric.id} className="bg-port-bg border border-port-border rounded-lg px-3 py-2">
            <div
              className={`text-xl font-semibold truncate ${
                metric.unavailable || metric.notApplicable ? 'text-gray-600' : 'text-port-accent'
              }`}
              title={metric.unavailable ? 'This stat could not be read' : undefined}
            >
              {metric.unavailable || metric.notApplicable ? '—' : formatMetricValue(metric)}
            </div>
            <div className="text-xs text-gray-300 truncate mt-0.5" title={metric.label}>
              {metric.label}
            </div>
            <div className="text-[11px] text-gray-500 mt-0.5 line-clamp-2">
              {metric.unavailable
                ? 'Unavailable'
                : metric.notApplicable
                  ? (metric.emptyLabel || 'Not applicable yet')
                  : metric.hint}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

export default function CharacterSheet() {
  const navigate = useNavigate();
  const [char, setChar] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [activeAction, setActiveAction] = useState(null);
  // The D&D damage/rest/dice/XP mechanics are legacy relative to the human-centered sheet
  // (#2677) — kept for back-compat with existing character.json + the RPG endpoints, but
  // collapsed out of the primary view so age-level / skills / goals / metrics lead. Opt-in.
  const [showLegacy, setShowLegacy] = useState(false);
  const [editingName, setEditingName] = useState(false);
  const [editingClass, setEditingClass] = useState(false);
  const [nameVal, setNameVal] = useState('');
  const [classVal, setClassVal] = useState('');
  // True while a name-save PUT is in flight. Gates re-opening the editor so a
  // reopened input (still showing the pre-save name) can't blur-save a stale
  // value back over the name the in-flight PUT is about to persist (#2409).
  const [nameSaving, setNameSaving] = useState(false);
  const [syncing, setSyncing] = useState(null);
  const [generatingAvatar, setGeneratingAvatar] = useState(false);
  const [diffusionProgress, setDiffusionProgress] = useState(null);
  const generatingRef = useRef(false);
  const generationIdRef = useRef(null);
  // Guards the name edit against a double-commit: Enter/Escape resolve the edit
  // and also blur the input, so both the key handler and the blur handler fire.
  // Whichever runs first flips this false; the other becomes a no-op.
  const nameEditingRef = useRef(false);

  // Form states
  const [dmgDice, setDmgDice] = useState('1d6');
  const [dmgDesc, setDmgDesc] = useState('');
  const [xpAmount, setXpAmount] = useState('');
  const [xpDesc, setXpDesc] = useState('');
  const [evtDesc, setEvtDesc] = useState('');
  const [evtXp, setEvtXp] = useState('');
  const [evtDice, setEvtDice] = useState('');

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const data = await charGet();
      if (!data || data.error) {
        setLoadError('Failed to load character data');
        return;
      }
      setChar(data);
      setNameVal(data.name || '');
      setClassVal(data.class || '');
    } catch (err) {
      setLoadError(err.message || 'Failed to load character data');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Listen for diffusion progress events while generating
  useEffect(() => {
    const onStarted = (data) => {
      if (generatingRef.current && !generationIdRef.current) {
        generationIdRef.current = data.generationId;
      }
    };
    const onProgress = (data) => {
      if (generatingRef.current && data.generationId === generationIdRef.current) {
        setDiffusionProgress(data);
      }
    };
    const onDone = (data) => {
      if (generatingRef.current && data.generationId === generationIdRef.current) {
        setDiffusionProgress(null);
      }
    };
    socket.on('image-gen:started', onStarted);
    socket.on('image-gen:progress', onProgress);
    socket.on('image-gen:completed', onDone);
    socket.on('image-gen:failed', onDone);
    return () => {
      socket.off('image-gen:started', onStarted);
      socket.off('image-gen:progress', onProgress);
      socket.off('image-gen:completed', onDone);
      socket.off('image-gen:failed', onDone);
    };
  }, []);

  const toggleAction = (action) => {
    setActiveAction(prev => prev === action ? null : action);
  };

  const handleDamage = async () => {
    try {
      const result = await charPost('/damage', { diceNotation: dmgDice, description: dmgDesc || undefined });
      setChar(result.character);
      setActiveAction(null);
      setDmgDice('1d6');
      setDmgDesc('');
    } catch (err) { toast.error(err.message || 'Failed to apply damage'); }
  };

  const handleShortRest = async () => {
    try {
      const result = await charPost('/rest', { type: 'short' });
      setChar(result.character);
    } catch (err) { toast.error(err.message || 'Failed to take short rest'); }
  };

  const handleLongRest = async () => {
    try {
      const result = await charPost('/rest', { type: 'long' });
      setChar(result.character);
    } catch (err) { toast.error(err.message || 'Failed to take long rest'); }
  };

  const handleAddXp = async () => {
    if (!xpAmount) return;
    try {
      const result = await charPost('/xp', { amount: Number(xpAmount), source: 'manual', description: xpDesc || undefined });
      setChar(result.character);
      setActiveAction(null);
      setXpAmount('');
      setXpDesc('');
    } catch (err) { toast.error(err.message || 'Failed to add XP'); }
  };

  const handleLogEvent = async () => {
    if (!evtDesc) return;
    try {
      const body = { description: evtDesc };
      if (evtXp) body.xp = Number(evtXp);
      if (evtDice) body.diceNotation = evtDice;
      const result = await charPost('/event', body);
      setChar(result.character);
      setActiveAction(null);
      setEvtDesc('');
      setEvtXp('');
      setEvtDice('');
    } catch (err) { toast.error(err.message || 'Failed to log event'); }
  };

  const handleSync = async (type) => {
    setSyncing(type);
    try {
      const result = await charPost(`/sync/${type}`, {});
      setChar(result.character);
    } catch (err) {
      toast.error(err.message || `Failed to sync ${type}`);
    } finally {
      setSyncing(null);
    }
  };

  const startNameEdit = () => {
    // Refuse to reopen while a prior save is still in flight — the reopened
    // input would seed from the pre-save `char.name` and a subsequent blur
    // could persist that stale value over the pending save (#2409).
    if (nameSaving) return;
    nameEditingRef.current = true;
    setNameVal(char.name || '');
    setEditingName(true);
  };

  // Resolve an in-progress name edit exactly once. `cancel` discards the edit
  // and restores the persisted name; otherwise the trimmed value is saved.
  const finishNameEdit = async (cancel) => {
    if (!nameEditingRef.current) return;
    nameEditingRef.current = false;
    setEditingName(false);
    if (cancel) {
      setNameVal(char.name || '');
      return;
    }
    // Save on any real change, INCLUDING clearing back to '' (which returns the sheet to the
    // "Your name" placeholder). Only a no-op — the trimmed value equal to what's persisted —
    // skips the PUT. Compare against `char.name || ''` so a blank→blank edit doesn't churn.
    const nextName = nameVal.trim();
    if (nextName === (char.name || '')) return;
    setNameSaving(true);
    try {
      const data = await charPut({ name: nextName });
      setChar(data);
    } catch (err) {
      toast.error(err.message || 'Failed to save name');
    } finally {
      setNameSaving(false);
    }
  };

  // Enter commits, Escape cancels. preventDefault keeps Enter from triggering
  // any accidental form submission.
  const handleNameKeyDown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      finishNameEdit(false);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      finishNameEdit(true);
    }
  };

  const handleClassSave = async () => {
    try {
      // Save on any real change, including clearing back to '' (restores the "Add a title"
      // placeholder); only a no-op skips the PUT.
      const nextClass = classVal.trim();
      if (nextClass !== (char.class || '')) {
        const data = await charPut({ class: nextClass });
        setChar(data);
      }
    } catch (err) { toast.error(err.message || 'Failed to save class'); }
    setEditingClass(false);
  };

  const handleGenerateAvatar = () => {
    setGeneratingAvatar(true);
    setDiffusionProgress(null);
    generatingRef.current = true;
    generationIdRef.current = null;
    // The route persists `avatarPath` onto the character server-side
    // (persistToCharacter), so no follow-up charPut is needed — keep the
    // optimistic setChar for instant feedback.
    generateAvatar({ name: char.name, characterClass: char.class, persistToCharacter: true }, { silent: true })
      .then(result => {
        setChar(prev => ({ ...prev, avatarPath: result.path }));
      })
      .catch(err => toast.error(err.message || 'Failed to generate avatar'))
      .finally(() => {
        setGeneratingAvatar(false);
        setDiffusionProgress(null);
        generatingRef.current = false;
        generationIdRef.current = null;
      });
  };

  if (loading) {
    return (
      <PageSkeleton
        header="bar"
        label="Loading character sheet"
        fullHeight
        padded
        // The Character bar is hand-rolled (not PageHeader): taller and card-tinted.
        barClassName="px-6 py-4 bg-port-card"
        bodyClassName="p-4 md:p-6"
        titleWidthClass="w-32"
        cards={4}
        sidebar={false}
      />
    );
  }

  if (loadError || !char) {
    return (
      <div className="h-full flex flex-col items-center justify-center text-gray-400 gap-4">
        <p className="text-port-error">{loadError || 'Failed to load character data'}</p>
        <button onClick={load} className="px-4 py-2 bg-port-accent/20 hover:bg-port-accent/30 text-port-accent rounded-lg text-sm transition-colors">
          Retry
        </button>
      </div>
    );
  }

  const hpPct = Math.max(0, Math.min(100, (char.hp / char.maxHp) * 100));
  // Level is age-derived now (#2673) — it no longer maps to an XP threshold, so the old
  // "XP toward next level" bar is gone. XP survives as a plain cumulative stat here; the
  // birthday-progress bar lives on the CyberCity HUD badge (full page reframe is Slice 5).
  const birthdayPct = Number.isFinite(char.ageYears)
    ? Math.round((char.ageYears - Math.floor(char.ageYears)) * 100)
    : 0;

  // No usable level → CTA distinguishes a genuinely unset birth date ("set") from a
  // present-but-unusable one ("fix" — invalid/future/unreadable) so the user isn't told to set
  // a date they already entered (#2757). Null when a real level exists (no CTA rendered).
  const birthCta = char.level == null ? birthDateCta(char.birthDateStatus) : null;

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-port-border bg-port-card">
        <div className="flex items-center gap-3">
          <UserRound className="w-6 h-6 text-port-accent" />
          <h1 className="text-xl font-semibold text-white">Character</h1>
        </div>
        <button
          onClick={() => { setLoading(true); load(); }}
          className="p-2 rounded-lg text-gray-400 hover:text-white hover:bg-port-border/50"
          title="Refresh"
        >
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-4 md:p-6 space-y-4">
        {/* Character Identity & Stats */}
        <div className="bg-port-card border border-port-border rounded-xl p-4 md:p-6">
          <div className="flex flex-col md:flex-row md:items-start gap-4">
            {/* Avatar */}
            <div className="flex-shrink-0">
              <div className="relative group w-20 h-20 rounded-lg overflow-hidden border border-port-border bg-port-bg">
                {generatingAvatar && diffusionProgress?.currentImage ? (
                  <img
                    src={`data:image/png;base64,${diffusionProgress.currentImage}`}
                    alt="Generating..."
                    className="w-full h-full object-cover"
                  />
                ) : char.avatarPath ? (
                  <img src={char.avatarPath} alt={char.name} className="w-full h-full object-cover" />
                ) : (
                  <div className="w-full h-full flex items-center justify-center text-gray-600">
                    <UserRound className="w-8 h-8" />
                  </div>
                )}
                {/* Progress bar overlay */}
                {generatingAvatar && (
                  <div className="absolute bottom-0 left-0 right-0 h-1.5 bg-black/40">
                    <div
                      className="h-full bg-port-accent transition-all duration-300"
                      style={{ width: `${(diffusionProgress?.progress ?? 0) * 100}%` }}
                    />
                  </div>
                )}
                <button
                  onClick={handleGenerateAvatar}
                  disabled={generatingAvatar}
                  className="absolute inset-0 flex items-center justify-center bg-black/60 opacity-40 sm:opacity-0 sm:group-hover:opacity-100 focus-visible:opacity-100 transition-opacity disabled:opacity-0"
                  title="Generate avatar"
                  aria-label="Generate avatar"
                >
                  <Image className="w-5 h-5 text-white" />
                </button>
                {generatingAvatar && !diffusionProgress?.currentImage && (
                  <div className="absolute inset-0 flex items-center justify-center bg-black/40">
                    <BrailleSpinner />
                  </div>
                )}
              </div>
              {generatingAvatar && diffusionProgress && (
                <div className="text-[10px] text-gray-500 text-center mt-1">
                  {diffusionProgress.step ?? 0}/{diffusionProgress.totalSteps ?? '?'}
                </div>
              )}
            </div>

            {/* Name, Class, Level */}
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-3 mb-1">
                {editingName ? (
                  <input
                    autoFocus
                    aria-label="Character name"
                    value={nameVal}
                    onChange={e => setNameVal(e.target.value)}
                    onBlur={() => finishNameEdit(false)}
                    onKeyDown={handleNameKeyDown}
                    className="bg-port-bg border border-port-border rounded px-2 py-1 text-2xl font-bold text-white w-full max-w-xs"
                  />
                ) : (
                  <button
                    type="button"
                    onClick={startNameEdit}
                    disabled={nameSaving}
                    aria-label={`Edit your name (currently ${char.name || 'Your name'})`}
                    className="text-2xl font-bold text-white cursor-pointer hover:text-port-accent transition-colors truncate text-left bg-transparent border-0 p-0 disabled:opacity-60 disabled:cursor-wait"
                  >
                    {char.name || 'Your name'}
                  </button>
                )}
              </div>
              <div className="flex items-center gap-2">
                {editingClass ? (
                  <input
                    autoFocus
                    value={classVal}
                    onChange={e => setClassVal(e.target.value)}
                    onBlur={handleClassSave}
                    onKeyDown={e => e.key === 'Enter' && handleClassSave()}
                    className="bg-port-bg border border-port-border rounded px-2 py-1 text-sm text-gray-300 w-full max-w-xs"
                  />
                ) : (
                  <span
                    onClick={() => setEditingClass(true)}
                    {...clickableProps(() => setEditingClass(true))}
                    className="text-sm text-gray-400 cursor-pointer hover:text-port-accent transition-colors"
                    title="Click to edit your title"
                  >
                    {char.class || 'Add a title'}
                  </span>
                )}
              </div>
            </div>

            {/* Level Badge — life experience = age (#2673). Rendered only when a birthDate is
                set; when the level is null the single call-to-action is the birth-date prompt
                banner below (avoids two adjacent CTAs firing the same navigation). */}
            {char.level != null && (
              <div className="flex-shrink-0 flex items-center gap-3">
                <div className="relative w-20 h-20 flex items-center justify-center rounded-full border-2 border-port-accent bg-port-bg">
                  <div className="text-center">
                    <div className="text-2xl font-bold text-port-accent">{char.level}</div>
                    <div className="text-[10px] uppercase tracking-wider text-gray-500">Level</div>
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Birth-date prompt — the human-centered level is age (#2673). Until a USABLE birth
              date is on record there is no level to show, so surface a clear call to action,
              deep-linking to the age editor where the field lives. A present-but-unusable date
              (invalid/future/unreadable, #2757) shows a "fix" prompt instead of "set" so the
              user isn't told to set a date they already entered. */}
          {birthCta && (
            <button
              type="button"
              onClick={() => navigate(birthCta.path)}
              className={`mt-4 w-full flex items-center gap-3 px-4 py-3 rounded-lg border border-dashed text-left transition-colors ${
                birthCta.kind === 'fix'
                  ? 'border-port-warning/50 bg-port-warning/5 hover:bg-port-warning/10'
                  : 'border-port-accent/50 bg-port-accent/5 hover:bg-port-accent/10'
              }`}
            >
              {birthCta.kind === 'fix'
                ? <AlertTriangle className="w-5 h-5 text-port-warning flex-shrink-0" />
                : <Cake className="w-5 h-5 text-port-accent flex-shrink-0" />}
              <div className="min-w-0">
                <div className="text-sm font-medium text-white">{birthCta.heading}</div>
                <div className="text-xs text-gray-400">{birthCta.caption}</div>
              </div>
            </button>
          )}

          {/* Progress toward the next birthday (fractional part of the current year of life) */}
          {char.level != null && (
            <div className="mt-3">
              <div className="flex items-center justify-between mb-1">
                <div className="text-sm font-medium text-gray-300">Next birthday</div>
                <span className="text-sm text-gray-400">{birthdayPct}%</span>
              </div>
              <div className="h-3 bg-port-bg rounded-full overflow-hidden border border-port-border">
                <div
                  className="h-full rounded-full transition-all duration-500 ease-out bg-port-accent"
                  style={{ width: `${birthdayPct}%` }}
                />
              </div>
            </div>
          )}
        </div>

        {/* Metrics — real engagement stats derived from existing domain signals (#2676).
            Sits directly under the identity card so the sheet's most concrete information is
            above the fold. */}
        <MetricsCard metrics={char.metrics} />

        {/* Life Goals — the human's real goals, mirrored read-only from the goals service
            (#2675). Owns its own fetch (the goals API is a separate surface from /character),
            so it is rendered unconditionally and handles its own loading/empty/error states. */}
        <GoalsCard />

        {/* Skills — derived per-domain from real PortOS usage (#2674) */}
        <SkillsCard skills={char.skills} />

        {/* Legacy RPG mechanics — demoted out of the primary view (#2677). Kept for
            back-compat with existing character.json and the damage/rest/dice/XP + JIRA/task
            sync endpoints (they still work); just collapsed by default so the human-centered
            content leads. */}
        <div className="bg-port-card border border-port-border rounded-xl">
          <button
            type="button"
            onClick={() => setShowLegacy(v => !v)}
            aria-expanded={showLegacy}
            className="w-full flex items-center gap-2 px-4 py-3 text-left text-gray-300 hover:text-white transition-colors"
          >
            <Dices className="w-4 h-4 text-gray-400" />
            <span className="text-sm font-medium">RPG mechanics</span>
            <span className="text-xs text-gray-500 hidden sm:inline">— legacy HP, XP, dice &amp; sync</span>
            <ChevronDown className={`w-4 h-4 text-gray-500 ml-auto transition-transform ${showLegacy ? 'rotate-180' : ''}`} />
          </button>

          {showLegacy && (
            <div className="px-4 pb-4 pt-2 border-t border-port-border space-y-4">
              {/* HP + XP — flat, backward-compatible mechanics (no longer scaled off level) */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <div className="flex items-center gap-1.5 text-sm font-medium text-gray-300">
                      <Heart className="w-4 h-4 text-port-error" />
                      HP
                    </div>
                    <span className="text-sm text-gray-400">{char.hp} / {char.maxHp}</span>
                  </div>
                  <div className="h-5 bg-port-bg rounded-full overflow-hidden border border-port-border">
                    <div
                      className={`h-full rounded-full transition-all duration-500 ease-out ${hpColor(hpPct)}`}
                      style={{ width: `${hpPct}%` }}
                    />
                  </div>
                </div>
                <div className="flex items-center justify-between sm:justify-start sm:gap-2 self-end pb-1">
                  <div className="flex items-center gap-1.5 text-sm font-medium text-gray-300">
                    <Sparkles className="w-4 h-4 text-port-warning" />
                    XP
                  </div>
                  <span className="text-sm text-gray-400">{char.xp}</span>
                </div>
              </div>

          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => toggleAction('damage')}
              className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                activeAction === 'damage'
                  ? 'bg-port-error text-white'
                  : 'bg-port-error/20 text-port-error hover:bg-port-error/30'
              }`}
            >
              <Sword className="w-4 h-4" /> Take Damage
              <ChevronDown className={`w-3 h-3 transition-transform ${activeAction === 'damage' ? 'rotate-180' : ''}`} />
            </button>

            <button
              onClick={handleShortRest}
              className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium bg-port-accent/20 text-port-accent hover:bg-port-accent/30 transition-colors"
            >
              <Moon className="w-4 h-4" /> Short Rest
            </button>

            <button
              onClick={handleLongRest}
              className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium bg-port-success/20 text-port-success hover:bg-port-success/30 transition-colors"
            >
              <Zap className="w-4 h-4" /> Long Rest
            </button>

            <button
              onClick={() => toggleAction('xp')}
              className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                activeAction === 'xp'
                  ? 'bg-port-warning text-black'
                  : 'bg-port-warning/20 text-port-warning hover:bg-port-warning/30'
              }`}
            >
              <Star className="w-4 h-4" /> Add XP
              <ChevronDown className={`w-3 h-3 transition-transform ${activeAction === 'xp' ? 'rotate-180' : ''}`} />
            </button>

            <button
              onClick={() => toggleAction('event')}
              className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                activeAction === 'event'
                  ? 'bg-port-accent-2 text-port-on-accent-2'
                  : 'bg-port-accent-2/20 text-port-accent-2 hover:bg-port-accent-2/30'
              }`}
            >
              <ScrollText className="w-4 h-4" /> Log Event
              <ChevronDown className={`w-3 h-3 transition-transform ${activeAction === 'event' ? 'rotate-180' : ''}`} />
            </button>

            <button
              onClick={() => handleSync('jira')}
              disabled={syncing === 'jira'}
              className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium bg-port-border/50 text-gray-300 hover:bg-port-border hover:text-white transition-colors disabled:opacity-50"
            >
              <RefreshCw className={`w-4 h-4 ${syncing === 'jira' ? 'animate-spin' : ''}`} /> Sync JIRA
            </button>

            <button
              onClick={() => handleSync('tasks')}
              disabled={syncing === 'tasks'}
              className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium bg-port-border/50 text-gray-300 hover:bg-port-border hover:text-white transition-colors disabled:opacity-50"
            >
              <RefreshCw className={`w-4 h-4 ${syncing === 'tasks' ? 'animate-spin' : ''}`} /> Sync Tasks
            </button>
          </div>

          {/* Inline Action Forms */}
          {activeAction === 'damage' && (
            <div className="mt-3 p-3 bg-port-bg rounded-lg border border-port-error/30 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-port-error">Roll Damage</span>
                <button onClick={() => setActiveAction(null)} aria-label="Close" className="text-gray-500 hover:text-white">
                  <X className="w-4 h-4" />
                </button>
              </div>
              <div className="flex flex-col sm:flex-row gap-2">
                <div className="flex items-center gap-2">
                  <Dices className="w-4 h-4 text-gray-400" />
                  <input
                    value={dmgDice}
                    onChange={e => setDmgDice(e.target.value)}
                    placeholder="1d8"
                    className="bg-port-card border border-port-border rounded px-2 py-1.5 text-sm text-white w-24"
                  />
                </div>
                <input
                  value={dmgDesc}
                  onChange={e => setDmgDesc(e.target.value)}
                  placeholder="Description (optional)"
                  className="bg-port-card border border-port-border rounded px-2 py-1.5 text-sm text-white flex-1"
                />
                <button
                  onClick={handleDamage}
                  className="px-4 py-1.5 bg-port-error text-white rounded text-sm font-medium hover:bg-port-error/80 transition-colors"
                >
                  Roll
                </button>
              </div>
            </div>
          )}

          {activeAction === 'xp' && (
            <div className="mt-3 p-3 bg-port-bg rounded-lg border border-port-warning/30 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-port-warning">Add Experience</span>
                <button onClick={() => setActiveAction(null)} aria-label="Close" className="text-gray-500 hover:text-white">
                  <X className="w-4 h-4" />
                </button>
              </div>
              <div className="flex flex-col sm:flex-row gap-2">
                <input
                  type="number"
                  value={xpAmount}
                  onChange={e => setXpAmount(e.target.value)}
                  placeholder="XP amount"
                  className="bg-port-card border border-port-border rounded px-2 py-1.5 text-sm text-white w-28"
                />
                <input
                  value={xpDesc}
                  onChange={e => setXpDesc(e.target.value)}
                  placeholder="Description (optional)"
                  className="bg-port-card border border-port-border rounded px-2 py-1.5 text-sm text-white flex-1"
                />
                <button
                  onClick={handleAddXp}
                  className="px-4 py-1.5 bg-port-warning text-black rounded text-sm font-medium hover:bg-port-warning/80 transition-colors"
                >
                  Add
                </button>
              </div>
            </div>
          )}

          {activeAction === 'event' && (
            <div className="mt-3 p-3 bg-port-bg rounded-lg border border-port-accent-2/30 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-port-accent-2">Log Event</span>
                <button onClick={() => setActiveAction(null)} aria-label="Close" className="text-gray-500 hover:text-white">
                  <X className="w-4 h-4" />
                </button>
              </div>
              <div className="flex flex-col gap-2">
                <input
                  value={evtDesc}
                  onChange={e => setEvtDesc(e.target.value)}
                  placeholder="What happened?"
                  className="bg-port-card border border-port-border rounded px-2 py-1.5 text-sm text-white"
                />
                <div className="flex flex-col sm:flex-row gap-2">
                  <input
                    type="number"
                    value={evtXp}
                    onChange={e => setEvtXp(e.target.value)}
                    placeholder="XP (optional)"
                    className="bg-port-card border border-port-border rounded px-2 py-1.5 text-sm text-white w-28"
                  />
                  <div className="flex items-center gap-2">
                    <Dices className="w-4 h-4 text-gray-400" />
                    <input
                      value={evtDice}
                      onChange={e => setEvtDice(e.target.value)}
                      placeholder="Dice (e.g. 2d6)"
                      className="bg-port-card border border-port-border rounded px-2 py-1.5 text-sm text-white w-32"
                    />
                  </div>
                  <button
                    onClick={handleLogEvent}
                    className="px-4 py-1.5 bg-port-accent-2 text-port-on-accent-2 rounded text-sm font-medium hover:bg-port-accent-2/80 transition-colors"
                  >
                    Log
                  </button>
                </div>
              </div>
            </div>
          )}

              {/* Event Log — the legacy events[] feed (damage/rest/xp/sync). Kept for
                  back-compat; lives inside the collapsed legacy section. */}
              <div className="bg-port-bg border border-port-border rounded-xl flex flex-col min-h-0">
                <div className="flex items-center gap-2 px-4 py-3 border-b border-port-border">
                  <ScrollText className="w-4 h-4 text-gray-400" />
                  <h3 className="text-sm font-medium text-gray-300">Event Log</h3>
                  <span className="text-xs text-gray-500">({char.events?.length || 0} entries)</span>
                </div>
          <div className="overflow-y-auto max-h-[400px] divide-y divide-port-border/50">
            {(!char.events || char.events.length === 0) ? (
              <div className="px-4 py-8 text-center text-gray-500 text-sm">
                No events yet. Take an action to begin your adventure.
              </div>
            ) : (
              [...char.events].reverse().map((evt, i) => {
                const Icon = EVENT_ICONS[evt.type] || ScrollText;
                const color = EVENT_COLORS[evt.type] || 'text-gray-400';
                return (
                  <div key={evt.id || i} className="px-4 py-3 flex items-start gap-3 hover:bg-port-bg/50 transition-colors">
                    <div className={`mt-0.5 ${color}`}>
                      <Icon className="w-4 h-4" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-baseline gap-2 flex-wrap">
                        <span className="text-sm text-white">{evt.description}</span>
                        {evt.xp > 0 && (
                          <span className="text-xs font-medium text-port-success">
                            +{evt.xp} XP
                          </span>
                        )}
                        {evt.damage > 0 && (
                          <span className="text-xs font-medium text-port-error">
                            -{evt.damage} HP
                          </span>
                        )}
                        {evt.hpRecovered > 0 && (
                          <span className="text-xs font-medium text-port-success">
                            +{evt.hpRecovered} HP
                          </span>
                        )}
                      </div>
                      {evt.diceNotation && (
                        <div className="flex items-center gap-1.5 mt-1">
                          <Dices className="w-3 h-3 text-gray-500" />
                          <span className="text-xs text-gray-500">
                            {evt.diceNotation}
                            {evt.diceRolls && evt.diceRolls.length > 0 && (
                              <> = [{evt.diceRolls.join(', ')}] = {evt.damage}</>
                            )}
                          </span>
                        </div>
                      )}
                    </div>
                    <span className="text-xs text-gray-600 whitespace-nowrap mt-0.5">
                      {timeAgo(evt.timestamp)}
                    </span>
                  </div>
                );
              })
            )}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
