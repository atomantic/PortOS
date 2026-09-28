import { useState } from 'react';
import { Bot, Play } from 'lucide-react';
import AutomationBriefFields, { automationDraftFrom, automationFromDraft } from './AutomationBriefFields.jsx';
import { MUSIC_VIDEO_AUTOMATION_TOOLS } from '../../../../server/lib/musicVideoAutomation.js';
import { formatUsd } from '../../utils/formatters.js';

const toolLabel = new Map(MUSIC_VIDEO_AUTOMATION_TOOLS.map((t) => [t.id, t.label]));

/**
 * The project's automation brief — tools, guidance, budget — shown first on
 * the board, with a one-click kickoff (analyze the song, then plan every shot
 * against the brief). Edits PATCH through `onSave`.
 */
export default function AutomationPanel({ project, onSave, onKickoff, kickoffBusy, kickoffBlockedReason }) {
  const [draft, setDraft] = useState(null);
  const [saving, setSaving] = useState(false);
  const automation = project.automation || null;
  const editing = draft !== null;

  const save = () => {
    setSaving(true);
    onSave(automationFromDraft(draft))
      .then(() => setDraft(null))
      // The page owns the error toast; a failed save keeps the brief open.
      .catch(() => {})
      .finally(() => setSaving(false));
  };

  return (
    <section className="bg-port-card border border-port-border rounded-lg p-3 space-y-2 min-w-0" aria-label="Autopilot">
      <div className="flex flex-wrap items-center gap-2">
        <Bot size={16} className="text-port-accent shrink-0" aria-hidden="true" />
        <h3 className="text-sm font-medium">Autopilot</h3>
        {automation && !editing && (
          <span className="text-xs text-port-text-muted">
            {automation.tools.length} tool{automation.tools.length === 1 ? '' : 's'}
            {' · '}
            {automation.budgetUsd != null ? `${formatUsd(automation.budgetUsd)} cap` : 'no budget cap'}
          </span>
        )}
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {!editing && (
            <button type="button" onClick={() => setDraft(automationDraftFrom(automation))} className="text-sm text-port-accent min-h-[44px] sm:min-h-0 px-1">
              {automation ? 'Edit brief' : 'Set up autopilot'}
            </button>
          )}
          {automation && !editing && (
            <button
              type="button"
              onClick={onKickoff}
              disabled={kickoffBusy || !!kickoffBlockedReason}
              title={kickoffBlockedReason || 'Analyze the song, then plan every shot against the brief'}
              className="flex items-center gap-1 bg-port-accent text-white rounded px-3 py-1.5 text-sm min-h-[44px] sm:min-h-0 disabled:opacity-50"
            >
              <Play size={14} /> {kickoffBusy ? 'Working…' : 'Analyze & plan'}
            </button>
          )}
        </div>
      </div>

      {!editing && automation && (
        <>
          {automation.tools.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {automation.tools.map((id) => (
                <span key={id} className="text-[11px] px-1.5 py-0.5 rounded bg-port-border">{toolLabel.get(id) || id}</span>
              ))}
            </div>
          )}
          <p className="text-xs text-port-text-muted break-words line-clamp-3">
            {automation.guidance || 'No guidance yet — the agent plans from the song, universe and board alone.'}
          </p>
          {kickoffBlockedReason && <p className="text-xs text-port-warning">{kickoffBlockedReason}</p>}
        </>
      )}
      {!editing && !automation && (
        <p className="text-xs text-port-text-muted">Hand this video to the agent: pick the tools it may use, give it guidance and a budget.</p>
      )}

      {editing && (
        <fieldset disabled={saving} className="space-y-3 min-w-0">
          <AutomationBriefFields idPrefix={`mv-auto-${project.id}`} draft={draft} onChange={(patch) => setDraft((d) => ({ ...d, ...patch }))} />
          <div className="flex flex-wrap gap-3">
            <button type="button" onClick={save} className="bg-port-accent text-white rounded px-3 py-2 text-sm min-h-[44px] sm:min-h-0 disabled:opacity-50">
              {saving ? 'Saving…' : 'Save brief'}
            </button>
            <button type="button" onClick={() => setDraft(null)} className="text-sm min-h-[44px] sm:min-h-0">Cancel</button>
          </div>
        </fieldset>
      )}
    </section>
  );
}
