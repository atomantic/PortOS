import { useState } from 'react';
import { Bot, Play } from 'lucide-react';
import AutomationBriefFields from './AutomationBriefFields.jsx';
import Pill from '../ui/Pill.jsx';
import { MUSIC_VIDEO_AUTOMATION_TOOLS, automationDraftFrom, automationFromDraft } from '../../lib/musicVideoAutomation.js';
import { formatUsd } from '../../utils/formatters.js';

const toolLabel = new Map(MUSIC_VIDEO_AUTOMATION_TOOLS.map((t) => [t.id, t.label]));
const actionClass = 'text-sm text-port-accent min-h-[44px] sm:min-h-0 px-1';

/**
 * The project's automation brief — tools, guidance, budget — shown first on
 * the board, with a one-click kickoff (analyze the song, import the track's
 * lyrics, separate vocals, align words, then plan every shot against the
 * brief). `kickoffStep` names the step running now. Edits PATCH through
 * `onSave`, which owns the error toast.
 */
export default function AutomationPanel({ project, onSave, onKickoff, kickoffBusy, kickoffStep = null, kickoffBlockedReason }) {
  const [draft, setDraft] = useState(null);
  const [saving, setSaving] = useState(false);
  const automation = project.automation || null;

  const save = () => {
    setSaving(true);
    onSave(automationFromDraft(draft))
      .then(() => setDraft(null))
      // A failed save keeps the brief open for another try.
      .catch(() => {})
      .finally(() => setSaving(false));
  };

  let header = null;
  let body;
  if (draft) {
    body = (
      <fieldset disabled={saving} className="space-y-3 min-w-0">
        <AutomationBriefFields idPrefix={`mv-auto-${project.id}`} draft={draft} onChange={(patch) => setDraft((d) => ({ ...d, ...patch }))} />
        <div className="flex flex-wrap gap-3">
          <button type="button" onClick={save} className="bg-port-accent text-white rounded px-3 py-2 text-sm min-h-[44px] sm:min-h-0 disabled:opacity-50">
            {saving ? 'Saving…' : 'Save brief'}
          </button>
          <button type="button" onClick={() => setDraft(null)} className="text-sm min-h-[44px] sm:min-h-0">Cancel</button>
        </div>
      </fieldset>
    );
  } else if (automation) {
    header = (
      <>
        <span className="text-xs text-port-text-muted">
          {automation.tools.length} tool{automation.tools.length === 1 ? '' : 's'}
          {' · '}
          {automation.budgetUsd != null ? `${formatUsd(automation.budgetUsd)} cap` : 'no budget cap'}
        </span>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <button type="button" onClick={() => setDraft(automationDraftFrom(automation))} className={actionClass}>Edit brief</button>
          <button
            type="button"
            onClick={onKickoff}
            disabled={kickoffBusy || !!kickoffBlockedReason}
            title={kickoffBlockedReason || 'Analyze the song, import its lyrics, separate and align the vocal, then plan every shot against the brief'}
            className="flex items-center gap-1 bg-port-accent text-white rounded px-3 py-1.5 text-sm min-h-[44px] sm:min-h-0 disabled:opacity-50"
          >
            <Play size={14} /> {kickoffBusy ? 'Working…' : 'Analyze & plan'}
          </button>
        </div>
      </>
    );
    body = (
      <>
        {automation.tools.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {automation.tools.map((id) => <Pill key={id} size="xs" bordered={false}>{toolLabel.get(id) || id}</Pill>)}
          </div>
        )}
        <p className="text-xs text-port-text-muted break-words line-clamp-3">
          {automation.guidance || 'No guidance yet — the agent plans from the song, universe and board alone.'}
        </p>
        {kickoffStep && <p className="text-xs text-port-accent" role="status">{kickoffStep}</p>}
        {kickoffBlockedReason && <p className="text-xs text-port-warning">{kickoffBlockedReason}</p>}
      </>
    );
  } else {
    header = (
      <button type="button" onClick={() => setDraft(automationDraftFrom(null))} className={`ml-auto ${actionClass}`}>Set up autopilot</button>
    );
    body = <p className="text-xs text-port-text-muted">Hand this video to the agent: pick the tools it may use, give it guidance and a budget.</p>;
  }

  return (
    <section className="bg-port-card border border-port-border rounded-lg p-3 space-y-2 min-w-0" aria-label="Autopilot">
      <div className="flex flex-wrap items-center gap-2">
        <Bot size={16} className="text-port-accent shrink-0" aria-hidden="true" />
        <h3 className="text-sm font-medium">Autopilot</h3>
        {header}
      </div>
      {body}
    </section>
  );
}
