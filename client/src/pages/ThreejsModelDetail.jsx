import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, Box, Check, Code2, Download, Info, LoaderCircle, RefreshCw, Trash2, X } from 'lucide-react';
import { Link, useNavigate, useParams } from 'react-router';
import MediaImage from '../components/MediaImage';
import ProviderModelSelector from '../components/ProviderModelSelector';
import SubjectFamilySelect from '../components/threejsModels/SubjectFamilySelect';
import ThreejsModelPreview from '../components/threejsModels/ThreejsModelPreview';
import PageSkeleton from '../components/ui/PageSkeleton';
import InlineConfirmRow from '../components/ui/InlineConfirmRow';
import useMounted from '../hooks/useMounted';
import useProviderModels from '../hooks/useProviderModels';
import useThreejsModelFamilies, { GENERAL_FAMILY_ID, resolveFamilyId } from '../hooks/useThreejsModelFamilies';
import {
  deleteThreejsModel,
  generateThreejsModel,
  getThreejsModel,
  getThreejsModelSource,
  threejsModelSourceUrl,
} from '../services/api';
import toast from '../components/ui/Toast';
import { copyToClipboard } from '../lib/clipboard';
import { listThreejsClips } from '../lib/threejsAnimation';
import { summarizeThreejsArticulation } from '../lib/threejsRig';
import { timeAgo } from '../utils/formatters';
import { seedModelEffort } from '../utils/providers';

const providerFilter = (provider) =>
  provider.enabled !== false && ['api', 'cli', 'tui'].includes(provider.type);

const MAX_IN_FLIGHT_POLLS = 2;
const POLL_TIMEOUT_MS = 30_000;

const SEVERITY_STYLE = {
  error: 'border-port-error/40 bg-port-error/10 text-port-error',
  warning: 'border-port-warning/40 bg-port-warning/10 text-port-warning',
  note: 'border-port-border bg-port-bg/50 text-gray-400',
};

// Counted from the findings actually rendered rather than read off the stored
// tallies, so a header can never disagree with the list below it — or print
// "undefined error" for a record whose gate result arrived without its counts.
// An unrecognized severity counts as a note rather than being dropped: the list
// still renders it (styled as a note), and a tally that omitted it would read
// "0 note" above a visible finding.
const countSeverities = (findings) => findings.reduce((counts, finding) => {
  const bucket = counts[finding.severity] === undefined ? 'note' : finding.severity;
  counts[bucket] += 1;
  return counts;
}, { error: 0, warning: 0, note: 0 });

/**
 * One quality-gate result (assembly coverage, cross-section) rendered as a
 * severity-styled finding list. Shared so a second gate cannot drift into a
 * different look for the same data.
 */
function GatePanel({ title, findings, cleanLabel, footer }) {
  const counts = countSeverities(findings);
  return (
    <section className="rounded-xl border border-port-border bg-port-card p-4">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-xs font-medium uppercase tracking-wide text-gray-400">{title}</h2>
        <span className="text-xs text-gray-600">
          {findings.length === 0
            ? cleanLabel
            : `${counts.error} error · ${counts.warning} warning · ${counts.note} note`}
        </span>
      </div>
      {findings.length > 0 && (
        <ul className="space-y-2">
          {findings.map((finding, index) => (
            <li
              key={`${finding.code}-${index}`}
              className={`rounded-lg border px-3 py-2 text-xs leading-relaxed ${SEVERITY_STYLE[finding.severity] || SEVERITY_STYLE.note}`}
            >
              <span className="mr-2 text-[9px] uppercase tracking-wide opacity-80">{finding.severity}</span>
              {finding.message}
            </li>
          ))}
        </ul>
      )}
      <p className="mt-3 flex items-start gap-1.5 text-[11px] leading-relaxed text-gray-500">
        <Info className="mt-0.5 h-3 w-3 shrink-0" />
        <span>{footer}</span>
      </p>
    </section>
  );
}

/**
 * The chosen subject family's checklist, with each required component marked
 * resolved or unresolved by the coverage pass, plus the axes and orbit views
 * worth checking against the live preview above. Snapshotted onto the record at
 * generation time, so it always describes the spec on screen — not whatever the
 * taxonomy happens to say today.
 */
function FamilyChecklistPanel({ family }) {
  const missing = new Set(family.missing || []);
  return (
    <section className="rounded-xl border border-port-border bg-port-card p-4">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-xs font-medium uppercase tracking-wide text-gray-400">
          {family.label} checklist
        </h2>
        <span className="text-xs text-gray-600">
          {missing.size === 0
            ? 'Every expected component is accounted for'
            : `${missing.size} of ${family.components.length} unaccounted for`}
        </span>
      </div>
      <ul className="grid gap-1.5 sm:grid-cols-2">
        {family.components.map((component) => {
          const unresolved = missing.has(component);
          return (
            <li
              key={component}
              className={`flex items-start gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs ${
                unresolved ? SEVERITY_STYLE.warning : 'border-port-border bg-port-bg/50 text-gray-300'
              }`}
            >
              {unresolved
                ? <X className="mt-0.5 h-3 w-3 shrink-0" />
                : <Check className="mt-0.5 h-3 w-3 shrink-0 text-port-success" />}
              <span>{component}</span>
            </li>
          );
        })}
      </ul>
      {family.reviewAxes?.length > 0 && (
        <p className="mt-3 text-[11px] leading-relaxed text-gray-500">
          <span className="text-gray-400">Judge it on:</span> {family.reviewAxes.join('; ')}.
        </p>
      )}
      {family.orbitViews?.length > 0 && (
        <p className="mt-1 text-[11px] leading-relaxed text-gray-500">
          <span className="text-gray-400">Orbit the preview to:</span> {family.orbitViews.join(', ')}.
        </p>
      )}
      <p className="mt-3 flex items-start gap-1.5 text-[11px] leading-relaxed text-gray-500">
        <Info className="mt-0.5 h-3 w-3 shrink-0" />
        <span>
          This list is a floor, not a ceiling — it is what this subject family is usually judged on,
          not the whole inventory. A component is marked accounted for when the spec names it
          anywhere, including a limitation explaining the reference does not show it.
        </span>
      </p>
    </section>
  );
}

/**
 * Static-versus-articulation-ready status for the generated spec, plus the
 * joint/pivot diagnostics behind it. Prefers the report the server wrote at
 * generation time; a record from before that shipped has none, and degrades to
 * an honest "static, and never evaluated" rather than borrowing a pass.
 */
function RigReadinessPanel({ rig, spec }) {
  const derived = summarizeThreejsArticulation(spec);
  const ready = rig ? rig.articulationReady === true : false;
  // A report that arrived without its counts (an older or newer peer, a
  // hand-repaired row) falls back to the spec rather than printing "undefined
  // joints" — the same rule the coverage panel applies to its tallies.
  const count = (key) => (Number.isFinite(rig?.[key]) ? rig[key] : derived[key]);
  const jointCount = count('jointCount');
  const socketCount = count('socketCount');
  const attachmentCount = count('attachmentCount');
  // A report written before anchors shipped carries no split, and inferring one
  // from the total would credit every legacy attachment as anchored — the exact
  // overstatement the split exists to remove. Fall back to the spec instead.
  const unanchoredAttachmentCount = count('unanchoredAttachmentCount');
  const reasons = Array.isArray(rig?.reasons) ? rig.reasons : [];
  return (
    <section className="rounded-xl border border-port-border bg-port-card p-4">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-xs font-medium uppercase tracking-wide text-gray-400">Rig readiness</h2>
        <span className={ready
          ? 'rounded bg-port-success/15 px-2 py-0.5 text-[10px] uppercase text-port-success'
          : 'rounded bg-port-border px-2 py-0.5 text-[10px] uppercase text-gray-400'}
        >
          {ready ? 'Articulation-ready' : 'Static assembly'}
        </span>
      </div>
      <p className="text-xs text-gray-400">
        {jointCount} joint{jointCount === 1 ? '' : 's'} · {socketCount} pivot socket{socketCount === 1 ? '' : 's'}
        {' · '}{attachmentCount} declared attachment{attachmentCount === 1 ? '' : 's'}
        {attachmentCount > 0 && ` (${attachmentCount - unanchoredAttachmentCount} anchored, ${unanchoredAttachmentCount} unanchored)`}
      </p>
      {!rig && (
        <p className="mt-2 rounded-lg border border-port-border bg-port-bg/50 px-3 py-2 text-xs leading-relaxed text-gray-400">
          This model was generated before rig readiness was reported, so it was never evaluated —
          regenerate it to get a verdict.
        </p>
      )}
      {reasons.length > 0 && (
        <ul className="mt-2 space-y-2">
          {reasons.map((reason) => (
            <li key={reason} className="rounded-lg border border-port-border bg-port-bg/50 px-3 py-2 text-xs leading-relaxed text-gray-400">
              {reason}
            </li>
          ))}
        </ul>
      )}
      <p className="mt-3 flex items-start gap-1.5 text-[11px] leading-relaxed text-gray-500">
        <Info className="mt-0.5 h-3 w-3 shrink-0" />
        <span>
          PortOS builds static assemblies. Articulation is a declaration of what is meant to move —
          stable joint ids, one root, and a named pivot socket per joint — never a skeleton: nothing
          here is skinned, bound to a bind pose, or exported as a rigged mesh.
        </span>
      </p>
    </section>
  );
}

/**
 * What the spec declared it can PLAY. Prefers the inventory the server wrote at
 * generation time and falls back to the spec's own clips, so a model generated
 * before clips shipped reads as the static assembly it is rather than borrowing
 * a verdict it was never given.
 */
function ClipInventoryPanel({ animation, spec }) {
  const clips = Array.isArray(animation?.clips) && animation.clips.length > 0
    ? animation.clips
    : listThreejsClips(spec).map((clip) => ({
      id: clip.id,
      name: clip.name,
      role: clip.role,
      durationSeconds: clip.durationSeconds,
      sequenceCount: clip.sequences?.length || 0,
      cueCount: new Set((clip.sequences || []).map((sequence) => sequence.cueId).filter(Boolean)).size,
    }));
  if (clips.length === 0) return null;
  return (
    <section className="rounded-xl border border-port-border bg-port-card p-4">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-xs font-medium uppercase tracking-wide text-gray-400">Animation clips</h2>
        <span className="text-xs text-gray-600">
          {clips.length} clip{clips.length === 1 ? '' : 's'}
        </span>
      </div>
      <div className="grid gap-2 md:grid-cols-2">
        {clips.map((clip) => (
          <div key={clip.id} className="rounded-lg border border-port-border bg-port-bg/50 p-2.5">
            <div className="flex items-start justify-between gap-2">
              <h3 className="text-xs font-medium text-gray-200">{clip.name}</h3>
              <span className="rounded bg-port-border px-1.5 py-0.5 text-[9px] uppercase text-gray-400">{clip.role || 'custom'}</span>
            </div>
            <p className="mt-1 text-xs text-gray-500">
              {clip.durationSeconds}s · {clip.sequenceCount} sequence{clip.sequenceCount === 1 ? '' : 's'}
              {clip.cueCount > 0 ? ` · ${clip.cueCount} sound cue${clip.cueCount === 1 ? '' : 's'}` : ''}
            </p>
          </div>
        ))}
      </div>
      <p className="mt-3 flex items-start gap-1.5 text-[11px] leading-relaxed text-gray-500">
        <Info className="mt-0.5 h-3 w-3 shrink-0" />
        <span>
          Clips are declared transforms over time, not a skeleton and not code — play or scrub them
          in the preview. Sound cues are identifiers only: PortOS ships no audio and plays none,
          and scrubbing never fires one.
        </span>
      </p>
    </section>
  );
}

export default function ThreejsModelDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [record, setRecord] = useState(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [starting, setStarting] = useState(false);
  const [effort, setEffort] = useState('');
  const families = useThreejsModelFamilies();
  const [family, setFamily] = useState(GENERAL_FAMILY_ID);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const providerSyncRef = useRef('');
  const {
    providers,
    selectedProviderId,
    selectedModel,
    availableModels,
    setSelectedProviderId,
    setSelectedModel,
    loading: providersLoading,
    // This picker renders the effort control and threads the value to the
    // server, so Antigravity lists base models with effort picked separately.
  } = useProviderModels({ filter: providerFilter, silent: true, withEffort: true });

  const mountedRef = useMounted();
  const lifecycleGenerationRef = useRef(0);
  const requestSequenceRef = useRef(0);
  const pollSequenceRef = useRef(0);
  const lastAppliedRequestRef = useRef(0);
  const inFlightPollsRef = useRef(new Map());
  const load = useCallback(async ({ initial = false, signal } = {}) => {
    const lifecycleGeneration = lifecycleGenerationRef.current;
    const requestSequence = ++requestSequenceRef.current;
    const isCurrent = () => mountedRef.current && lifecycleGeneration === lifecycleGenerationRef.current;
    const isAuthoritative = () => isCurrent() && requestSequence >= lastAppliedRequestRef.current;
    if (initial && isCurrent()) {
      setLoading(true);
      setNotFound(false);
      setRecord(null);
    }
    const next = await getThreejsModel(id, {
      silent: true,
      ...(signal ? { signal } : {}),
    }).catch((error) => {
      if (!isAuthoritative()) return null;
      if (error.status === 404) {
        lastAppliedRequestRef.current = requestSequence;
        setNotFound(true);
      } else if (initial) toast.error(error.message || 'Failed to load model');
      return null;
    });
    if (!isAuthoritative()) return null;
    if (next) {
      lastAppliedRequestRef.current = requestSequence;
      setRecord(next);
      setNotFound(false);
    }
    if (initial) setLoading(false);
    return next;
  }, [id, mountedRef]);

  useEffect(() => {
    lifecycleGenerationRef.current += 1;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), POLL_TIMEOUT_MS);
    void load({ initial: true, signal: controller.signal }).finally(() => clearTimeout(timeoutId));
    return () => {
      clearTimeout(timeoutId);
      controller.abort();
      lifecycleGenerationRef.current += 1;
    };
  }, [id, load]);

  useEffect(() => {
    if (loading || notFound || record?.id !== id || record?.status !== 'generating') return undefined;
    const handle = setInterval(() => {
      if (inFlightPollsRef.current.size >= MAX_IN_FLIGHT_POLLS) return;
      const pollSequence = ++pollSequenceRef.current;
      const controller = new AbortController();
      const poll = { controller, timeoutId: null };
      inFlightPollsRef.current.set(pollSequence, poll);
      poll.timeoutId = setTimeout(() => {
        if (inFlightPollsRef.current.get(pollSequence)?.controller !== controller) return;
        inFlightPollsRef.current.delete(pollSequence);
        controller.abort();
      }, POLL_TIMEOUT_MS);
      void load({ signal: controller.signal }).finally(() => {
        const activePoll = inFlightPollsRef.current.get(pollSequence);
        if (activePoll?.controller !== controller) return;
        clearTimeout(activePoll.timeoutId);
        inFlightPollsRef.current.delete(pollSequence);
      });
    }, 2_000);
    return () => {
      clearInterval(handle);
      for (const { controller, timeoutId } of inFlightPollsRef.current.values()) {
        clearTimeout(timeoutId);
        controller.abort();
      }
      inFlightPollsRef.current.clear();
      lifecycleGenerationRef.current += 1;
    };
  }, [loading, notFound, record?.id, record?.status, id, load]);

  useEffect(() => {
    if (!record || providers.length === 0) return;
    const key = `${record.id}:${record.providerId}:${record.model || ''}:${record.effort || ''}`;
    if (providerSyncRef.current === key) return;
    const recordProvider = providers.find((provider) => provider.id === record.providerId);
    if (recordProvider) {
      // A record written before Antigravity split model from effort stores the
      // suffixed id (`gemini-3.6-flash-high`); seedModelEffort reads it back as
      // a base model + its effort so the pin isn't an option that no longer
      // exists (and leaves every other provider's id untouched).
      const seeded = seedModelEffort(recordProvider, record.model, record.effort);
      setSelectedProviderId(record.providerId);
      setSelectedModel(seeded.model);
      setEffort(seeded.effort);
    }
    providerSyncRef.current = key;
  }, [record, providers, setSelectedProviderId, setSelectedModel]);

  // Kept out of the provider-sync effect above: the family belongs to the record,
  // not to the provider, so a record whose provider is gone (or an install with
  // none configured) must still read its stored family back into the picker.
  // Re-seeds per record id only, so a user's in-form change survives the
  // 2s poll while a generation is running.
  useEffect(() => {
    setFamily(record?.family || GENERAL_FAMILY_ID);
  }, [record?.id]);

  const handleGenerate = async () => {
    if (!selectedProviderId || record?.status === 'generating') return;
    setStarting(true);
    const next = await generateThreejsModel(id, {
      providerId: selectedProviderId,
      model: selectedModel || undefined,
      // Always sent (as `''` when unset) so picking "Default effort" CLEARS the
      // record's stored override instead of silently re-applying it.
      effort,
      // Always sent so switching back to General turns the checklist OFF for
      // this pass instead of silently re-applying the record's stored family.
      // Resolved against the served taxonomy so what is sent is what the picker
      // is showing, even for a record holding a family this install dropped.
      family: resolveFamilyId(families, family),
      prompt: record.prompt || '',
      feedback: feedback.trim(),
    }, { silent: true }).catch((error) => {
      toast.error(error.message || 'Failed to start generation');
      return null;
    });
    setStarting(false);
    if (next) {
      setRecord(next);
      setFeedback('');
      toast.success(record.spec ? 'Refinement started' : 'Generation started');
    }
  };

  const handleCopySource = async () => {
    const source = await getThreejsModelSource(id, { silent: true }).catch((error) => {
      toast.error(error.message || 'Failed to load source');
      return null;
    });
    if (source) await copyToClipboard(source, 'Three.js source copied');
  };

  const handleDelete = async () => {
    const ok = await deleteThreejsModel(id, { silent: true }).then(() => true).catch((error) => {
      toast.error(error.message || 'Delete failed');
      return false;
    });
    if (ok) navigate('/media/threejs');
  };

  if (loading) {
    return (
      <div className="mx-auto max-w-7xl">
        <PageSkeleton label="Loading model" titleWidthClass="w-56" cards={2} sidebar={false} />
      </div>
    );
  }
  if (notFound || !record) {
    return (
      <div className="py-12 text-center">
        <p className="mb-3 text-gray-400">That Three.js model does not exist.</p>
        <Link to="/media/threejs" className="text-port-accent hover:underline">Back to models</Link>
      </div>
    );
  }

  const generating = record.status === 'generating' || starting;
  const latestRun = Array.isArray(record.runs) ? record.runs[record.runs.length - 1] : null;
  // A record generated before a gate shipped has no result at all, which is not
  // the same as passing it — the panel is omitted rather than shown clean.
  const coverageFindings = Array.isArray(record.coverage?.findings) ? record.coverage.findings : null;
  const flatnessFindings = Array.isArray(record.flatness?.findings) ? record.flatness.findings : null;
  const flatnessHasWarnings = flatnessFindings?.some((finding) => finding.severity === 'warning');
  const penetrationFindings = Array.isArray(record.penetration?.findings) ? record.penetration.findings : null;
  // An attachment whose anchor could not be measured was not checked, so it is
  // rendered as a note rather than left to the panel's clean label — "no
  // findings" and "never verified" must not read the same on screen.
  const unmeasuredAttachments = Array.isArray(record.physicalAudit?.unmeasuredAttachments)
    ? record.physicalAudit.unmeasuredAttachments
    : [];
  const physicalAuditFindings = Array.isArray(record.physicalAudit?.findings)
    ? [
      ...record.physicalAudit.findings,
      ...unmeasuredAttachments.map((entry) => ({
        code: 'unmeasured-attachment',
        severity: 'note',
        message: `Attachment "${entry.partId}" could not be checked against ${entry.anchorSocket ? `socket "${entry.anchorSocket}"` : `"${entry.anchorPartId}"`} because ${entry.reason}.`,
      })),
    ]
    : null;
  const materialFindings = Array.isArray(record.materialPlausibility?.findings)
    ? record.materialPlausibility.findings
    : null;
  // A clean verdict only means something for a model that declared clips —
  // rendering "clips play cleanly" on every static model would be noise about a
  // feature it never used. A finding is worth showing either way: the gate also
  // reports an articulation graph that declares motion with no clip to play it,
  // which by definition arrives on a model with no clips.
  const animationFindings = Array.isArray(record.animation?.findings)
    && (record.animation.animated || record.animation.findings.length > 0)
    ? record.animation.findings
    : null;
  // Undecided contact is a note the reader is meant to judge, never something a
  // refinement is told to fix — so the footer only promises a refinement when
  // there is an actual defect above it.
  const penetrationDefects = countSeverities(penetrationFindings || []);
  const physicalAuditDefects = countSeverities(physicalAuditFindings || []);
  const coverageErrors = countSeverities(coverageFindings || []).error;
  // Only present when the generation ran with a family — a record generated
  // under `general` (or before families shipped) has no checklist to render.
  const coverageFamily = Array.isArray(record.coverage?.family?.components)
    ? record.coverage.family
    : null;
  // The record's own family, not the coverage snapshot's — the header should
  // read the current setting even before the next generation re-runs the gate.
  // Resolved like the picker is, so a record holding a family this install no
  // longer ships does not have the header and the picker naming two different
  // things; the coverage panel below still reports the checklist that ran.
  const activeFamily = resolveFamilyId(families, record.family);
  const familyLabel = activeFamily && activeFamily !== GENERAL_FAMILY_ID
    ? (families.find((option) => option.id === activeFamily)?.label || activeFamily)
    : '';

  return (
    <div className="mx-auto max-w-7xl space-y-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Link to="/media/threejs" className="mb-2 inline-flex items-center gap-1 text-xs text-gray-500 hover:text-white">
            <ArrowLeft className="h-3.5 w-3.5" /> Three.js Models
          </Link>
          <div className="flex items-center gap-2">
            <Box className="h-6 w-6 text-port-accent" />
            <h1 className="text-xl font-semibold text-white">{record.name}</h1>
            <span className={`rounded px-2 py-0.5 text-[10px] uppercase ${
              record.status === 'ready' ? 'bg-port-success/15 text-port-success'
                : record.status === 'failed' ? 'bg-port-error/15 text-port-error'
                  : 'bg-port-accent/15 text-port-accent'
            }`}>
              {record.status}
            </span>
          </div>
          <p className="mt-1 text-xs text-gray-500">
            {record.providerId}{record.model ? ` · ${record.model}` : ''}{record.effort ? ` · ${record.effort} effort` : ''}
            {familyLabel ? ` · ${familyLabel}` : ''} · updated {timeAgo(record.updatedAt)}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {record.spec && (
            <>
              <button
                type="button"
                onClick={handleCopySource}
                className="inline-flex items-center gap-1.5 rounded border border-port-border px-2.5 py-1.5 text-xs text-gray-300 hover:bg-port-border/50 hover:text-white"
              >
                <Code2 className="h-3.5 w-3.5" /> Copy source
              </button>
              <a
                href={threejsModelSourceUrl(id)}
                download
                className="inline-flex items-center gap-1.5 rounded border border-port-border px-2.5 py-1.5 text-xs text-gray-300 hover:bg-port-border/50 hover:text-white"
              >
                <Download className="h-3.5 w-3.5" /> Download
              </a>
            </>
          )}
          <button
            type="button"
            onClick={() => setConfirmingDelete(true)}
            className="rounded p-1.5 text-gray-500 hover:bg-port-error/10 hover:text-port-error"
            aria-label={`Delete ${record.name}`}
            title="Delete model"
          >
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
      </header>

      {confirmingDelete && (
        <InlineConfirmRow
          question={`Delete "${record.name}"?`}
          onConfirm={handleDelete}
          onCancel={() => setConfirmingDelete(false)}
        />
      )}

      {record.error && (
        <div className="rounded-lg border border-port-error/30 bg-port-error/10 px-3 py-2 text-sm text-port-error">
          {record.error}
        </div>
      )}

      <section className="grid min-h-[520px] overflow-hidden rounded-xl border border-port-border bg-port-card lg:grid-cols-[240px_1fr]">
        <aside className="border-b border-port-border p-3 lg:border-b-0 lg:border-r">
          <div className="aspect-square overflow-hidden rounded-lg bg-port-bg">
            <MediaImage
              src={record.sourceImage?.path}
              alt={`Reference for ${record.name}`}
              className="h-full w-full object-contain"
            />
          </div>
          <p className="mt-2 break-all text-xs text-gray-500">{record.sourceImage?.filename}</p>
          {record.spec?.summary && <p className="mt-3 text-xs leading-relaxed text-gray-300">{record.spec.summary}</p>}
          {record.spec?.limitations?.length > 0 && (
            <div className="mt-3">
              <h2 className="text-[10px] uppercase tracking-wide text-gray-500">Known limitations</h2>
              <ul className="mt-1 list-disc space-y-1 pl-4 text-xs text-gray-400">
                {record.spec.limitations.map((item) => <li key={item}>{item}</li>)}
              </ul>
            </div>
          )}
        </aside>
        <div className="relative min-h-[520px]">
          <ThreejsModelPreview spec={record.spec} family={coverageFamily} className="h-full min-h-[520px] w-full" />
          {generating && (
            <div className="port-media-overlay absolute inset-x-0 top-0 flex items-center justify-center gap-2 border-b border-port-border px-3 py-2 text-xs">
              <LoaderCircle className="h-4 w-4 animate-spin text-port-accent" />
              Inspecting the reference and building procedural geometry…
            </div>
          )}
        </div>
      </section>

      <section className="grid gap-4 rounded-xl border border-port-border bg-port-card p-4 lg:grid-cols-[1fr_2fr_auto] lg:items-end">
        <ProviderModelSelector
          providers={providers}
          selectedProviderId={selectedProviderId}
          selectedModel={selectedModel}
          availableModels={availableModels}
          onProviderChange={setSelectedProviderId}
          onModelChange={setSelectedModel}
          effort={effort}
          onEffortChange={setEffort}
          disabled={providersLoading || generating}
          alwaysShowModel
          emptyModelOption="Provider default"
          label={record.spec ? 'Refinement provider' : 'Generation provider'}
          layout="stacked"
        />
        <div>
          <SubjectFamilySelect
            id="threejs-family"
            families={families}
            value={family}
            onChange={setFamily}
            disabled={generating}
            className="mb-3"
          />
          <label htmlFor="threejs-feedback" className="mb-1 block text-xs text-gray-400">
            {record.spec ? 'Refinement feedback' : 'Generation direction'}
          </label>
          <textarea
            id="threejs-feedback"
            value={feedback}
            onChange={(event) => setFeedback(event.target.value)}
            maxLength={2_000}
            rows={3}
            disabled={generating}
            placeholder={record.spec
              ? 'Make the handle thicker, separate the lid pivot, and match the warm brass trim.'
              : 'Describe what matters most in this reconstruction.'}
            className="w-full resize-y rounded-lg border border-port-border bg-port-bg px-3 py-2 text-sm text-white placeholder:text-gray-600 focus:border-port-accent focus:outline-none disabled:opacity-50"
          />
        </div>
        <button
          type="button"
          onClick={handleGenerate}
          disabled={generating || !selectedProviderId}
          className="inline-flex items-center justify-center gap-2 rounded-lg bg-port-accent px-4 py-2 text-sm text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {generating ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          {record.spec ? 'Refine model' : 'Generate model'}
        </button>
      </section>

      {coverageFindings && (
        <GatePanel
          title="Assembly coverage"
          findings={coverageFindings}
          cleanLabel="Nothing promised was left unbuilt"
          footer={`${coverageFamily
            ? 'This check proves the model built what its own spec promised; the subject-family checklist below is what holds the spec itself to a floor.'
            : 'This check proves the model built what its own spec promised — never that the spec promised enough.'}${
            coverageErrors > 0 ? ' Refining without your own feedback will target the errors above.' : ''
          }`}
        />
      )}

      {coverageFamily && <FamilyChecklistPanel family={coverageFamily} />}

      {flatnessFindings && (
        <GatePanel
          title="Cross-section"
          findings={flatnessFindings}
          cleanLabel="Identity parts carry real depth"
          footer={`A model can match its reference head-on and still be a stack of cardboard cut-outs, so this check counts how many identity-defining features are built only from flat parts.${
            flatnessHasWarnings ? ' Refining without your own feedback will also ask for real depth.' : ''
          }`}
        />
      )}

      {penetrationFindings && (
        <GatePanel
          title="Cross-part penetration"
          findings={penetrationFindings}
          cleanLabel="No unrelated parts share the same space"
          footer={`Parts modelled inside each other look correct from the hero angle and fall apart the moment the model is orbited, so this check compares every unrelated pair by volume. Parts parented together or declared as attachments are exempt — embedding is what those relationships are for.${
            penetrationDefects.error + penetrationDefects.warning > 0
              ? ' Refining without your own feedback will also ask for each part to get its own volume.'
              : ''
          }`}
        />
      )}

      {physicalAuditFindings && (
        <GatePanel
          title="Physical audit"
          findings={physicalAuditFindings}
          cleanLabel="Assembly satisfies physical attachment, exposure, and coplanarity rules"
          footer={`This check inspects the model across resting and animation poses to detect floating parts, swallowed geometry, z-fighting coplanar surfaces, unprovenanced appearing geometry, non-uniform parent scales that distort nested parts, and attachments that name nothing to hang from or sit further from their declared anchor than the spec allows.${
            physicalAuditDefects.error + physicalAuditDefects.warning > 0
              ? ' Refining without your own feedback will also target physical conformance defects.'
              : ''
          }`}
        />
      )}

      {materialFindings && (
        <GatePanel
          title="Material plausibility"
          findings={materialFindings}
          cleanLabel={record.materialPlausibility?.matchedMaterialCount > 0
            ? 'Recognized materials match their substance'
            : 'No material named a substance to check'}
          footer={`Every channel here is already inside what Three.js accepts, so this check asks the other question: whether the values suit the substance the material is named for — metallic wood and opaque glass both parse. Only materials whose id names exactly one substance are checked, and nothing is ever adjusted.${
            countSeverities(materialFindings).warning > 0
              ? ' Refining without your own feedback will also ask for values that match the substance — keep any deliberate stylization in your own feedback.'
              : ''
          }`}
        />
      )}

      {record.spec && (
        <RigReadinessPanel
          rig={record.rig && typeof record.rig === 'object' ? record.rig : null}
          spec={record.spec}
        />
      )}

      {record.spec && (
        <ClipInventoryPanel
          animation={record.animation && typeof record.animation === 'object' ? record.animation : null}
          spec={record.spec}
        />
      )}

      {animationFindings && (
        <GatePanel
          title="Clip playback"
          findings={animationFindings}
          cleanLabel="Clips open, hand over, and loop cleanly"
          footer={`The schema already proves a clip is well formed, so this check asks whether it will actually play: a clip authored against a pose the assembly does not build jumps the instant it opens, a handover between sequences that do not meet jumps mid-clip, and a loop that ends somewhere else snaps on every repeat.${
            animationFindings.length > 0
              ? ' Refining without your own feedback will also ask for clips that start from the assembled pose and close their loops.'
              : ''
          }`}
        />
      )}

      {record.spec?.detailInventory?.length > 0 && (
        <section className="rounded-xl border border-port-border bg-port-card p-4">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-xs font-medium uppercase tracking-wide text-gray-400">Detail inventory</h2>
            <span className="text-xs text-gray-600">{record.spec.detailInventory.length} modeled features</span>
          </div>
          <div className="grid gap-2 md:grid-cols-2">
            {record.spec.detailInventory.map((detail, index) => (
              <div key={`${detail.feature}-${index}`} className="rounded-lg border border-port-border bg-port-bg/50 p-2.5">
                <div className="flex items-start justify-between gap-2">
                  <h3 className="text-xs font-medium text-gray-200">{detail.feature}</h3>
                  <span className="rounded bg-port-border px-1.5 py-0.5 text-[9px] uppercase text-gray-400">{detail.priority}</span>
                </div>
                <p className="mt-1 text-xs text-gray-500">{detail.evidence}</p>
                <p className="mt-1 text-[10px] text-port-accent">{detail.implementationPartIds.join(' · ')}</p>
              </div>
            ))}
          </div>
        </section>
      )}

      {latestRun && (
        <p className="text-right text-[10px] text-gray-600">
          Latest run {latestRun.status}{latestRun.runId ? ` · ${latestRun.runId}` : ''}
        </p>
      )}
    </div>
  );
}
