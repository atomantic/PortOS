// The Prompt Manager's Agent Skills tab: the agentskills.io skill registry with
// the Skill Curator's telemetry, pin/lock/adopt/archive/restore controls, a
// curator dry-run, and the mutation ledger with single-entry rollback (#17391).
// Edits here go through the human edit route, so a lock (which only stops
// agents) never blocks them.
import { useEffect, useRef, useState } from 'react';
import { History, Lock, Pin, Save, Sparkles } from 'lucide-react';
import toast from '../ui/Toast';
import Drawer from '../Drawer';
import Pill from '../ui/Pill';
import { FormField } from '../ui/FormField';
import InlineConfirmRow from '../ui/InlineConfirmRow';
import {
  applySkillAction, editSkill, getCuratorStatus, getSkillLedger, getSkills, rollbackSkillLedgerEntry, runCurator, viewSkill,
} from '../../services/apiSkills';
import { formatCount, timeAgo } from '../../utils/formatters';
import CatalogueNotice from './CatalogueNotice';
import PromptWorkspace from './PromptWorkspace';
import usePromptCatalogue from './usePromptCatalogue';
import useRecordEditor from './useRecordEditor';
import useSelectionParam from './useSelectionParam';

const EMPTY_LIST = Object.freeze({ skills: [], archived: [], quarantined: [] });
const loadSkills = () => getSkills({ silent: true });
const selectList = (res) => ({ skills: res.skills || [], archived: res.archived || [], quarantined: res.quarantined || [], usageUnavailable: res.usageUnavailable === true });
const loadStatus = () => getCuratorStatus({ silent: true });
const selectStatus = (res) => res;
const isArchivedId = (id) => typeof id === 'string' && id.startsWith('archive:');
// An archived skill is not in the live index, so there is no document to read.
const loadSkill = (id) => (isArchivedId(id) ? Promise.resolve({ content: '' }) : viewSkill(id, { silent: true }));

const STATE_TONES = { active: 'success', stale: 'warning', archived: 'muted' };
const ACTION_LABELS = {
  pin: 'Pinned', unpin: 'Unpinned', lock: 'Locked', unlock: 'Unlocked', adopt: 'Handed to the curator', archive: 'Archived', restore: 'Restored',
};
const btn = 'flex items-center gap-1 px-3 py-1 text-sm rounded border border-port-border bg-port-border hover:bg-port-border/80 text-white disabled:opacity-50';

function SkillBadges({ skill, archived }) {
  const usage = skill.usage;
  const state = archived ? 'archived' : usage?.state;
  return (
    <span className="flex flex-wrap items-center gap-1">
      {state && <Pill size="xs" tone={STATE_TONES[state] || 'muted'} className="uppercase">{state}</Pill>}
      <Pill size="xs" tone="context">{skill.tier}</Pill>
      {usage?.pinned && <Pill size="xs" tone="accent" icon={Pin}>pinned</Pill>}
      {usage?.locked && <Pill size="xs" tone="warning" icon={Lock}>locked</Pill>}
      {usage?.createdBy === 'agent' && <Pill size="xs" tone="note">curated</Pill>}
    </span>
  );
}

function UsageLine({ usage }) {
  if (!usage) return null;
  return (
    <span className="text-xs text-gray-500">
      {formatCount(usage.viewCount, { fallback: '0' })} views · {formatCount(usage.useCount, { fallback: '0' })} agent uses · {formatCount(usage.patchCount, { fallback: '0' })} edits
      {usage.lastUsedAt ? ` · used ${timeAgo(usage.lastUsedAt)}` : ''}
    </span>
  );
}

function CuratorPanel({ status, failed, onReload, onChanged }) {
  const [busy, setBusy] = useState(false);
  const [plan, setPlan] = useState(null);
  const [confirmRun, setConfirmRun] = useState(false);

  const run = async (dryRun) => {
    setBusy(true);
    setConfirmRun(false);
    const res = await runCurator({ dryRun }, { silent: true })
      .catch((err) => { toast.error(`Curator ${dryRun ? 'preview' : 'pass'} failed: ${err.message || 'Unknown error'}`); return null; });
    setBusy(false);
    if (!res) return;
    setPlan(res);
    if (!dryRun) {
      toast.success(`Curator pass: ${res.transitions.length} change(s)`);
      onChanged();
    }
  };

  const counts = status?.counts;
  return (
    <div className="mb-4 rounded-lg border border-port-border bg-port-bg p-3 @container">
      <div className="flex items-center gap-2 text-sm font-medium text-gray-300"><Sparkles size={14} /> Skill Curator</div>
      {failed && <CatalogueNotice label="Curator status" stale={Boolean(status)} onRetry={onReload} />}
      {status && (
        <div className="mt-1 space-y-1 text-xs text-gray-500 [overflow-wrap:anywhere]">
          <div>Stale after {status.config.staleAfterDays} idle days, archived after {status.config.archiveAfterDays}. Only agent-created or adopted local skills are curated.</div>
          {counts ? (
            <div>
              {formatCount(counts.active, { fallback: '0' })} active · {formatCount(counts.stale, { fallback: '0' })} stale · {formatCount(counts.archived, { fallback: '0' })} archived · {formatCount(counts.pinned, { fallback: '0' })} pinned · {formatCount(counts.locked, { fallback: '0' })} locked
            </div>
          ) : <div className="text-port-warning">Usage telemetry is unreadable; the curator is paused until data/skills/.usage.json is repaired.</div>}
          <div>
            Scheduled job {status.job?.enabled ? 'enabled' : 'disabled (enable “Skill Curator” in autonomous jobs to run it daily)'}
            {status.lastRun?.at ? ` · last pass ${timeAgo(status.lastRun.at)}` : ' · never run'}
          </div>
        </div>
      )}
      <div className="mt-2 flex flex-wrap gap-2">
        <button type="button" className={btn} disabled={busy || !counts} onClick={() => run(true)}>Preview pass</button>
        <button type="button" className={btn} disabled={busy || !counts} onClick={() => setConfirmRun(true)}>Run now</button>
      </div>
      {confirmRun && (
        <InlineConfirmRow
          className="mt-2 rounded-lg"
          tone="warning"
          question="Run the curator now? Idle skills become stale and long-idle ones move to the archive (reversible)."
          confirmText="Run pass"
          onConfirm={() => run(false)}
          onCancel={() => setConfirmRun(false)}
        />
      )}
      {plan && (
        <div className="mt-2 rounded border border-port-border p-2 text-xs text-gray-400" role="status">
          <div className="font-medium text-gray-300">{plan.dryRun ? 'Planned changes (nothing applied)' : 'Applied changes'}</div>
          {plan.transitions.length === 0 ? <div>No skill changes state.</div> : (
            <ul className="mt-1 space-y-0.5">
              {plan.transitions.map((entry) => (
                <li key={entry.id} className="[overflow-wrap:anywhere]">{entry.id}: {entry.from} → {entry.to} ({formatCount(entry.idleDays, { fallback: '0' })} idle days)</li>
              ))}
            </ul>
          )}
          {plan.failures?.length > 0 && <div className="text-port-error">{plan.failures.length} archive move(s) failed; see the server log.</div>}
        </div>
      )}
    </div>
  );
}

function LedgerDrawer({ open, onClose, onRolledBack }) {
  const [entries, setEntries] = useState(null);
  const [failed, setFailed] = useState(false);
  const [confirmId, setConfirmId] = useState(null);
  const [busyId, setBusyId] = useState(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!open) return undefined;
    let active = true;
    setFailed(false);
    getSkillLedger({ limit: 200 }, { silent: true })
      .then((res) => { if (active) setEntries(res.entries || []); })
      .catch(() => { if (active) setFailed(true); });
    return () => { active = false; };
  }, [open, attempt]);

  const rollback = async (entry) => {
    setConfirmId(null);
    setBusyId(entry.id);
    const res = await rollbackSkillLedgerEntry(entry.id, { silent: true })
      .catch((err) => { toast.error(`Rollback failed: ${err.message || 'Unknown error'}`); return null; });
    setBusyId(null);
    if (!res) return;
    toast.success(`Rolled back ${entry.action} of ${entry.skill?.id || 'skill'}`);
    if (res.usageReconciled === false) toast.error('Files restored, but the skill\'s usage record could not be updated');
    setAttempt((n) => n + 1);
    onRolledBack();
  };

  return (
    <Drawer open={open} onClose={onClose} title="Skill change history" subtitle="Every local skill write, newest first" size="md" closeLabel="Close skill change history">
      {failed && <CatalogueNotice label="Change history" stale={Boolean(entries)} onRetry={() => setAttempt((n) => n + 1)} />}
      {entries === null && !failed && <div className="text-sm text-gray-500" role="status">Loading change history…</div>}
      {entries?.length === 0 && <div className="text-sm text-gray-500">No skill changes recorded yet.</div>}
      <ul className="space-y-2">
        {entries?.map((entry) => (
          <li key={entry.id} className="rounded-lg border border-port-border p-2 text-sm">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0 [overflow-wrap:anywhere]">
                <span className="font-medium text-white">{entry.action}</span>{' '}
                <span className="text-gray-400">{entry.skill?.id}</span>
              </div>
              <button type="button" className={btn} disabled={busyId !== null} onClick={() => setConfirmId(entry.id)}>
                {busyId === entry.id ? 'Rolling back…' : 'Roll back'}
              </button>
            </div>
            <div className="mt-1 text-xs text-gray-500">
              by {entry.actor} · {timeAgo(entry.at)} · {formatCount(entry.before?.files, { fallback: '0' })} → {formatCount(entry.after?.files, { fallback: '0' })} file(s)
              {entry.afterUnavailable ? ' · after-state not recorded' : ''}
            </div>
            {confirmId === entry.id && (
              <InlineConfirmRow
                className="mt-2 rounded-lg"
                tone="warning"
                question={`Restore the files this ${entry.action} touched to how they were before it? The current state is saved first, so this is reversible too.`}
                confirmText="Roll back"
                aria-label={`Confirm rolling back ${entry.action} of ${entry.skill?.id}`}
                autoFocus
                onConfirm={() => rollback(entry)}
                onCancel={() => setConfirmId(null)}
              />
            )}
          </li>
        ))}
      </ul>
    </Drawer>
  );
}

export default function AgentSkillsEditor({ splitPane, reloadKey, onDirtyChange }) {
  const [selected, setSelected] = useSelectionParam('agentSkill');
  const catalogue = usePromptCatalogue(loadSkills, selectList, EMPTY_LIST, reloadKey);
  const status = usePromptCatalogue(loadStatus, selectStatus, null, reloadKey);
  const { skills, archived, quarantined, usageUnavailable } = catalogue.data;
  const [chooserOpen, setChooserOpen] = useState(false);
  const [ledgerOpen, setLedgerOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [busyAction, setBusyAction] = useState(null);
  const [confirmArchive, setConfirmArchive] = useState(false);
  // The text the server last confirmed: a save patches it to the edited text.
  const baselineRef = useRef('');

  const editor = useRecordEditor({
    selected,
    blank: '',
    load: loadSkill,
    hydrate: (res) => {
      baselineRef.current = res.content || '';
      return res.content || '';
    },
    onReset: () => setConfirmArchive(false),
    noun: 'skill',
    onSwitch: (id) => switchSkill(id),
    onReselect: () => setChooserOpen(false),
  });

  const isArchived = isArchivedId(selected);
  const skill = (isArchived ? archived : skills).find((candidate) => candidate.id === selected) || null;
  const openLabel = skill?.name || selected;
  const editable = Boolean(skill) && skill.tier === 'local' && !isArchived;

  useEffect(() => {
    onDirtyChange?.(editor.dirty ? openLabel : null);
    return () => onDirtyChange?.(null);
  }, [editor.dirty, openLabel, onDirtyChange]);

  const switchSkill = (id) => {
    setChooserOpen(false);
    editor.reset();
    setSelected(id);
  };

  const refresh = () => Promise.all([catalogue.reload(), status.reload()]);

  const saveSkill = async () => {
    if (!editor.ready || saving || !editable) return;
    setSaving(true);
    const sent = editor.value;
    const sentFor = selected;
    const ok = await editSkill({ action: 'patch', name: sentFor, oldString: baselineRef.current, newString: sent }, { silent: true })
      .then(() => true)
      .catch((err) => { toast.error(`Failed to save skill: ${err.message || 'Unknown error'}`); return false; });
    setSaving(false);
    if (!ok) return;
    baselineRef.current = sent;
    editor.markSaved(sentFor, sent);
    toast.success('Skill saved');
    await refresh();
  };

  const runAction = async (action) => {
    if (!skill || busyAction) return;
    setConfirmArchive(false);
    setBusyAction(action);
    const ref = action === 'restore' ? skill.originalId || skill.id : skill.id;
    const res = await applySkillAction(ref, action, { silent: true })
      .catch((err) => { toast.error(`${action} failed: ${err.message || 'Unknown error'}`); return null; });
    setBusyAction(null);
    if (!res) return;
    toast.success(`${ACTION_LABELS[action]}: ${skill.name}`);
    await refresh();
    // The skill changed identity: follow it to its new place.
    if (action === 'archive' && res.archivePath) switchSkill(`archive:${res.archivePath.replace(/^\.archive\//, '')}`);
    if (action === 'restore' && res.skill?.id) switchSkill(res.skill.id);
  };

  const renderRow = (entry, inArchive) => (
    editor.isPending(entry.id) ? (
      <InlineConfirmRow
        key={entry.id}
        className="rounded-lg"
        question={`Discard unsaved changes to "${openLabel}"?`}
        confirmText="Discard"
        cancelText="Keep editing"
        aria-label={`Confirm discarding unsaved changes to ${openLabel}`}
        autoFocus
        onConfirm={() => switchSkill(entry.id)}
        onCancel={editor.cancelPending}
      />
    ) : (
      <button
        key={entry.id}
        type="button"
        onClick={() => editor.request(entry.id)}
        className={`w-full text-left px-3 py-2 rounded-lg text-sm ${selected === entry.id ? 'bg-port-accent/20 text-port-accent' : 'text-gray-300 hover:bg-port-border'}`}
      >
        <div className="flex flex-wrap items-center gap-1">
          <span className="font-medium [overflow-wrap:anywhere]">{entry.name}</span>
          <SkillBadges skill={entry} archived={inArchive} />
        </div>
        {entry.description && <div className="text-xs text-gray-500 [overflow-wrap:anywhere]">{entry.description}</div>}
      </button>
    )
  );

  const skillCatalogue = (
    <>
      <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="text-sm font-medium text-gray-400">Agent Skills</h3>
          <p className="text-xs text-gray-500 mt-1">Procedural skills agents load on demand</p>
        </div>
        <button type="button" className={btn} onClick={() => setLedgerOpen(true)}><History size={14} /> History</button>
      </div>
      <CuratorPanel status={status.data} failed={status.failed} onReload={status.reload} onChanged={refresh} />
      {catalogue.failed && <CatalogueNotice label="Agent skills" stale={catalogue.loaded} onRetry={catalogue.reload} />}
      {usageUnavailable && (
        <div role="alert" className="mb-2 rounded-lg border border-port-warning/40 bg-port-warning/10 px-3 py-2 text-xs text-port-warning">
          Usage telemetry is unreadable, so counts, pins and locks are hidden and agent skill writes are refused until data/skills/.usage.json is repaired.
        </div>
      )}
      <div className="space-y-1">
        {skills.map((entry) => renderRow(entry, false))}
        {skills.length === 0 && !catalogue.failed && <div className="text-sm text-gray-500 px-3 py-2">No skills found</div>}
      </div>
      {archived.length > 0 && (
        <>
          <h4 className="mt-4 mb-1 text-xs font-medium uppercase text-gray-500">Archived</h4>
          <div className="space-y-1">{archived.map((entry) => renderRow(entry, true))}</div>
        </>
      )}
      {quarantined.length > 0 && (
        <>
          <h4 className="mt-4 mb-1 text-xs font-medium uppercase text-gray-500">Quarantined</h4>
          <ul className="space-y-1">
            {quarantined.map((entry) => (
              <li key={entry.id} className="px-3 py-2 text-sm text-gray-400">
                <div className="flex flex-wrap items-center gap-1">
                  <span className="font-medium [overflow-wrap:anywhere]">{entry.name}</span>
                  <Pill size="xs" tone="error" className="uppercase">quarantined</Pill>
                  <Pill size="xs" tone="context">{entry.tier}</Pill>
                </div>
                <div className="text-xs text-gray-500">{(entry.findings || []).map((finding) => finding.reason).filter(Boolean).slice(0, 2).join('; ')}</div>
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  );

  const usage = skill?.usage;
  const actionButton = (action, label, icon) => (
    <button key={action} type="button" className={btn} disabled={Boolean(busyAction) || saving || editor.dirty} onClick={() => runAction(action)}>
      {icon}{busyAction === action ? `${label}…` : label}
    </button>
  );
  const skillEditor = selected ? (
    <div className="bg-port-card border border-port-border rounded-xl p-4 @container">
      <div className="flex flex-col gap-3 mb-4 @sm:flex-row @sm:items-start @sm:justify-between">
        <div className="min-w-0 @sm:flex-1">
          <h3 className="break-words text-lg font-medium text-white">{openLabel}</h3>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-gray-500 [overflow-wrap:anywhere]">
            {skill && <SkillBadges skill={skill} archived={isArchived} />}
            <span>{selected}</span>
            {editor.dirty && <span className="text-port-warning">Unsaved changes</span>}
          </div>
          <div className="mt-1"><UsageLine usage={usage} /></div>
        </div>
        {editable && (
          <div className="flex w-full max-w-full flex-wrap gap-2 @sm:w-auto @sm:shrink-0">
            <button type="button" onClick={saveSkill} disabled={!editor.ready || saving || !editor.dirty} className="flex items-center gap-1 px-3 py-1 text-sm bg-port-accent hover:bg-port-accent/80 text-white rounded disabled:opacity-50">
              <Save size={14} /> Save
            </button>
          </div>
        )}
      </div>

      {skill && usage && (
        <div className="mb-4 flex flex-wrap gap-2">
          {!isArchived && skill.tier === 'local' && actionButton(usage.pinned ? 'unpin' : 'pin', usage.pinned ? 'Unpin' : 'Pin', <Pin size={14} />)}
          {!isArchived && skill.tier === 'local' && actionButton(usage.locked ? 'unlock' : 'lock', usage.locked ? 'Unlock' : 'Lock', <Lock size={14} />)}
          {!isArchived && skill.tier === 'local' && usage.createdBy !== 'agent' && actionButton('adopt', 'Let curator manage', null)}
          {!isArchived && skill.tier === 'local' && !usage.pinned && (
            <button type="button" className={btn} disabled={Boolean(busyAction) || saving || editor.dirty} onClick={() => setConfirmArchive(true)}>Archive</button>
          )}
          {isArchived && actionButton('restore', 'Restore', null)}
        </div>
      )}
      {confirmArchive && (
        <InlineConfirmRow
          className="mb-4 rounded-lg"
          tone="warning"
          question={`Move "${openLabel}" to the archive? Agents stop seeing it; Restore or the change history brings it back.`}
          confirmText="Archive"
          aria-label={`Confirm archiving ${openLabel}`}
          autoFocus
          onConfirm={() => runAction('archive')}
          onCancel={() => setConfirmArchive(false)}
        />
      )}
      {usage?.locked && editable && <p className="mb-3 text-xs text-gray-500">Locked: agents cannot change or delete this skill. Your edits here still save.</p>}

      {isArchived ? (
        <p className="text-sm text-gray-400">Archived skills are hidden from agents. Restore it to read or edit it again.</p>
      ) : (
        <>
          {!editor.ready && (
            <div role={editor.readFailed ? 'alert' : 'status'} className="mb-4 text-sm text-gray-400">
              {editor.readFailed ? (
                <>Failed to load skill: {editor.read.error}{' '}
                  <button type="button" onClick={editor.retryRead} className="text-port-accent hover:underline">Retry</button>
                </>
              ) : 'Loading skill…'}
            </div>
          )}
          <FormField label={editable ? 'SKILL.md' : 'SKILL.md (read-only outside the local tier)'}>
            <textarea
              disabled={!editor.ready}
              readOnly={!editable}
              value={editor.value}
              onChange={(e) => editor.setValue(e.target.value)}
              className="w-full h-96 px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white font-mono text-sm focus:border-port-accent focus:outline-hidden"
            />
          </FormField>
        </>
      )}
    </div>
  ) : (
    <div className="bg-port-card border border-port-border rounded-xl p-12 text-center text-gray-500">
      <p>Select a skill to see its usage and controls</p>
      <p className="text-xs mt-2">Pin a skill to keep it from being archived; lock it to stop agents changing it</p>
    </div>
  );

  return (
    <>
      <PromptWorkspace
        splitPane={splitPane}
        loading={!catalogue.settled}
        catalogue={skillCatalogue}
        editor={skillEditor}
        active={Boolean(selected)}
        noun="skill"
        title="Agent Skills"
        chooserOpen={chooserOpen}
        onChooserOpenChange={setChooserOpen}
      />
      <LedgerDrawer open={ledgerOpen} onClose={() => setLedgerOpen(false)} onRolledBack={refresh} />
    </>
  );
}
