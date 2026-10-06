import { useState } from 'react';
import MediaModePicker from './MediaModePicker.jsx';
import VideoRenderSettings from './VideoRenderSettings.jsx';
import RecordRenderPinRow from '../imageGen/RecordRenderPinRow.jsx';
import ToggleChip from '../ui/ToggleChip.jsx';
import Pill from '../ui/Pill.jsx';
import { RenderStyleSelect } from './ProjectActionGroups.jsx';
import { compositionDraft, RENDER_STYLE_HELP } from './compositionDraft.js';
import { normalizeMusicVideoProductionPolicy } from '../../../../server/lib/musicVideoMediumPlan.js';
import { MUSIC_VIDEO_AUTOMATION_TOOLS, automationDraftFrom, automationFromDraft } from '../../lib/musicVideoAutomation.js';
import { musicVideoMediaMode } from '../../../../server/lib/musicVideoMediaPolicy.js';
import { formatUsd } from '../../utils/formatters.js';
import { finishedOutsideBlocker } from '../../../../server/lib/musicVideoFinishedOutside.js';
import { setMusicVideoFinishedOutside } from '../../services/apiMusicVideo.js';

const TOOL_GROUPS = [['image', 'Image'], ['video', 'Video'], ['code', 'Code']];
const rowCls = 'grid min-w-0 grid-cols-1 gap-1 sm:grid-cols-[9rem_minmax(0,1fr)] sm:items-start sm:gap-3';
const headCls = 'pt-1.5 text-xs font-medium text-port-text-muted';

/** One line naming the project's options, for the folded Setup section's summary. */
/**
 * Project settings › Project: what kind of project this is and which services it
 * renders with, each editable in place — the workflow (autopilot or hands-on),
 * the media the design may use (code / images / video), the render style, the
 * image and video services, and, for an autopilot project, the tools the
 * autopilot may spend on and its Cast & Sets check-in. Every change saves to the
 * project through the same paths the Make step's controls use. A project made
 * elsewhere can be marked finished outside PortOS, so Song through Make stop
 * asking for approvals that were never given here (`onProjectUpdated` gets the
 * saved record).
 */
export default function ProjectOptionsPanel({
  project, videoSettings, generatingVideos = false, onMediaMode, onRenderStyle, onSaveAutomation, onSavePolicy, onProjectUpdated,
}) {
  // The stored marker, even while it does not count (no final render yet), so it can still be cleared.
  const external = project.finishedOutside?.markedAt ? project.finishedOutside : null;
  const outsideBlocker = external ? null : finishedOutsideBlocker(project);
  const [outsideNote, setOutsideNote] = useState('');
  const [outsideSaving, setOutsideSaving] = useState(false);
  const toggleFinishedOutside = () => {
    if (outsideSaving) return;
    setOutsideSaving(true);
    setMusicVideoFinishedOutside(project.id, { finished: !external, note: outsideNote.trim() || undefined })
      .then((next) => { setOutsideNote(''); onProjectUpdated?.(next); })
      .catch(() => {}) // request() already toasted
      .finally(() => setOutsideSaving(false));
  };
  const [policyError, setPolicyError] = useState('');
  const [allowanceText, setAllowanceText] = useState(null);
  const policy = normalizeMusicVideoProductionPolicy(project.productionPolicy);
  const savePolicy = (next) => {
    setPolicyError('');
    return Promise.resolve(onSavePolicy(next)).catch((err) => setPolicyError(err?.message || 'Could not save the production strategy'));
  };
  const commitAllowance = (text) => {
    setAllowanceText(null);
    const percent = Number(text);
    if (text === '' || !Number.isFinite(percent) || percent < 0 || percent > 100) {
      setPolicyError('Choose a generated-video allowance from 0 to 100%.');
      return;
    }
    if (percent !== Number(policy.maxGeneratedVideoPercent)) savePolicy({ ...policy, maxGeneratedVideoPercent: percent });
  };
  const [briefSaving, setBriefSaving] = useState(false);
  const automation = project.automation || null;
  const draft = automation ? automationDraftFrom(automation) : null;
  const saveBrief = (patch) => {
    if (!automation || briefSaving) return;
    setBriefSaving(true);
    Promise.resolve(onSaveAutomation(automationFromDraft({ ...draft, ...patch }, automation)))
      .catch(() => {}) // the page's save already toasted
      .finally(() => setBriefSaving(false));
  };
  const picked = new Set(draft?.tools || []);
  const toggleTool = (id) => saveBrief({ tools: MUSIC_VIDEO_AUTOMATION_TOOLS.map((t) => t.id).filter((t) => (t === id ? !picked.has(t) : picked.has(t))) });

  return (
    <div className="min-w-0 space-y-3">
      <div className={rowCls}>
        <span className={headCls}>Workflow</span>
        <div className="flex min-w-0 flex-wrap items-center gap-2 text-xs text-port-text-muted">
          <Pill size="xs" tone={automation ? 'accent' : 'muted'}>{automation ? 'Autopilot' : 'Director (hands-on)'}</Pill>
          <span>{automation
            ? 'The autopilot plans and produces from its brief. Guidance, models and limits are under Produce.'
            : 'You build the board by hand. Saving an autopilot brief under Produce hands it to the autopilot.'}</span>
        </div>
      </div>
      <div className={rowCls}>
        <span className={headCls}>Media</span>
        <MediaModePicker id="mv-setup-media-mode" value={musicVideoMediaMode(project)} onChange={onMediaMode} />
      </div>
      <div className={rowCls}>
        <span className={headCls} aria-hidden="true">Render style</span>
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <RenderStyleSelect project={project} onRenderStyle={onRenderStyle} />
          <span className="text-xs text-port-text-muted">How the final video is put together; Compose holds its details.</span>
          <p className="w-full text-xs text-port-text-muted" id="mv-setup-render-style-help">{RENDER_STYLE_HELP[compositionDraft(project).mode] || RENDER_STYLE_HELP.concat}</p>
        </div>
      </div>
      <div className={rowCls}>
        <label htmlFor="mv-setup-strategy" className={headCls}>Production strategy</label>
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <select id="mv-setup-strategy" value={policy.strategy}
            onChange={(e) => savePolicy(normalizeMusicVideoProductionPolicy({ strategy: e.target.value }, policy))}
            className="min-h-[44px] rounded border border-port-border bg-port-bg px-2 py-1.5 text-sm sm:min-h-0">
            <option value="legacy">Legacy / manual workflow</option>
            <option value="code-first">Code-first medium planning</option>
          </select>
          {policy.strategy === 'code-first' && (
            <>
              <label htmlFor="mv-setup-video-allowance" className="text-xs text-port-text-muted">Maximum generated video (% of final song time)</label>
              <input id="mv-setup-video-allowance" type="number" min="0" max="100" step="any"
                value={allowanceText ?? policy.maxGeneratedVideoPercent}
                onChange={(e) => setAllowanceText(e.target.value)}
                onBlur={(e) => commitAllowance(e.target.value)}
                className="min-h-[44px] w-24 rounded border border-port-border bg-port-bg px-2 py-1.5 text-sm sm:min-h-0" />
              <p className="w-full text-xs text-port-text-muted">Start with code and images. This plans final-edit seconds; it does not change the renderer or enforce generation budgets in manual controls.</p>
            </>
          )}
          {policyError && <p role="alert" className="w-full text-xs text-port-error">{policyError}</p>}
        </div>
      </div>
      <div className={rowCls}>
        <span className={headCls}>Image service</span>
        <RecordRenderPinRow
          idPrefix="mv-setup-frame-pin"
          label="Frames"
          imageMode={project.imageMode ?? null}
          imageModelId={project.imageModelId ?? null}
          onChange={videoSettings.changeFramePin}
        />
      </div>
      <div className={rowCls}>
        <span className={headCls}>Video service</span>
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <VideoRenderSettings videoSettings={videoSettings} generating={generatingVideos} />
        </div>
      </div>
      <div className={rowCls}>
        <span className={headCls}>Finished outside PortOS</span>
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          {!outsideBlocker && <ToggleChip
            id="mv-setup-finished-outside"
            label={external ? 'Marked finished' : 'Mark finished'}
            hint="Song, Look, Storyboard and Make count as done; Final render and Publish still need the real render and posts"
            checked={!!external}
            onToggle={toggleFinishedOutside}
          />}
          {!external && !outsideBlocker && (
            <input
              type="text"
              aria-label="Where it was made (optional)"
              placeholder="Where it was made (optional)"
              maxLength={500}
              value={outsideNote}
              onChange={(e) => setOutsideNote(e.target.value)}
              className="min-h-[44px] min-w-0 flex-1 rounded border border-port-border bg-port-bg px-2 py-1.5 text-sm sm:min-h-0"
            />
          )}
          <p className="w-full text-xs text-port-text-muted">
            {outsideBlocker || (external
              ? `Marked ${new Date(external.markedAt).toLocaleDateString()}${external.note ? `: ${external.note}` : ''}. No approval is recorded; unmark to bring the step checks back.`
              : 'For a video made elsewhere: Song through Make count as done without recording approvals. Final render and Publish still need the real render and posts.')}
          </p>
        </div>
      </div>
      {automation && (
        <>
          <fieldset className={rowCls} disabled={briefSaving} aria-labelledby="mv-setup-tools-label">
            <span id="mv-setup-tools-label" className={headCls}>Autopilot may use</span>
            <div className="grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-3">
              {TOOL_GROUPS.map(([group, label]) => (
                <div key={group} className="min-w-0 rounded border border-port-border p-2">
                  <div className="mb-1 text-[11px] uppercase tracking-wide text-port-text-muted">{label}</div>
                  <div className="flex flex-wrap gap-1.5">
                    {MUSIC_VIDEO_AUTOMATION_TOOLS.filter((t) => t.group === group).map((tool) => (
                      <ToggleChip
                        key={tool.id}
                        id={`mv-setup-tool-${tool.id}`}
                        label={tool.metered ? `${tool.label} $` : tool.label}
                        hint={tool.metered ? 'Spends money or remote quota' : 'Runs on this machine'}
                        checked={picked.has(tool.id)}
                        onToggle={() => toggleTool(tool.id)}
                      />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </fieldset>
          <div className={rowCls}>
            <label htmlFor="mv-setup-checkin" className={headCls}>Cast &amp; Sets check-in</label>
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <select
                id="mv-setup-checkin"
                value={draft.castAndSetsCheckin}
                disabled={briefSaving}
                onChange={(e) => saveBrief({ castAndSetsCheckin: e.target.value })}
                className="min-h-[44px] rounded border border-port-border bg-port-bg px-2 py-1.5 text-sm sm:min-h-0"
              >
                <option value="review">Stop for my review</option>
                <option value="auto">Auto-approve</option>
              </select>
              <span className="text-xs text-port-text-muted">
                Budget cap: {automation.budgetUsd != null ? formatUsd(automation.budgetUsd) : 'none'} (set under Produce)
              </span>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
