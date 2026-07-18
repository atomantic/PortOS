/**
 * Editable configuration form for a Creative Commission (#2657).
 *
 * The pure field sections of a commission's brief/schedule/generation/assignment,
 * shared by the index create drawer and the routed detail page. Run history +
 * render previews are rendered separately (see RenderHistory.jsx) so this stays a
 * config-only surface — the create drawer has no runs, and the detail page shows
 * renders in a dedicated gallery above the config.
 *
 * State lives in the PARENT (per the Drawer state-hoisting rule); this component
 * is fully controlled via `form` + `patchForm`.
 */

import { useEffect, useMemo, useState } from 'react';
import ProviderModelSelector from '../ProviderModelSelector';
import { isProcessProvider } from '../../utils/providers';
import { getProviders } from '../../services/api';
import { WEEKDAYS, inputCls, labelCls, describeSchedule } from './commissionForm.js';

export default function CommissionConfigForm({ form, patchForm, saving, onSave, onCancel, saveLabel = 'Save' }) {
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

      {/* AI provider & model — who processes this commission */}
      <section className="space-y-2 border-t border-port-border pt-4">
        <h3 className="text-sm font-semibold text-gray-200">AI provider &amp; model</h3>
        <p className="text-xs text-gray-500">
          Which AI writes the treatment and production plan each time this commission runs. Leave on the
          default to use your install&apos;s configured Creative Director assignment.
        </p>
        <AssignmentPicker
          assignment={form.assignment}
          onChange={(next) => patchForm(['assignment'], next)}
        />
      </section>

      {/* Feedback conditioning */}
      <section className="space-y-2 border-t border-port-border pt-4">
        <h3 className="text-sm font-semibold text-gray-200">Feedback conditioning</h3>
        <div className="flex items-center gap-3">
          <label className={`${labelCls} mb-0`} htmlFor="commission-feedback-window">Recent reactions to steer by</label>
          <input
            id="commission-feedback-window"
            type="number"
            min={0}
            max={50}
            className={`${inputCls} w-20`}
            value={form.feedbackWindow}
            onChange={(e) => patchForm(['feedbackWindow'], e.target.value)}
          />
        </div>
        <p className="text-xs text-gray-500">
          The last N ratings + notes are folded into the next run&apos;s brief. 0 disables conditioning.
        </p>
      </section>

      <div className="flex items-center gap-2 border-t border-port-border pt-4">
        <button
          onClick={onSave}
          disabled={saving}
          className="bg-port-accent hover:bg-blue-600 disabled:opacity-50 text-white px-4 py-2 rounded text-sm font-medium"
        >
          {saving ? 'Saving…' : saveLabel}
        </button>
        {onCancel && (
          <button onClick={onCancel} className="text-gray-400 hover:text-gray-200 px-4 py-2 text-sm">Cancel</button>
        )}
      </div>
    </div>
  );
}

// AI provider/model picker for the commission's CD cognitive stages (treatment +
// plan). Mirrors SeriesLlmPicker: fetches the provider list, drives the shared
// ProviderModelSelector, and reports changes up to form state via `onChange`.
// Only agent-harness (CLI/TUI) providers are offered — an API-type provider
// injected into a CoS agent task trips the server's harness-boundary guard.
//
// The empty option deliberately does NOT name a specific provider: an unset pin
// resolves at fire time to `settings.creativeDirector.{treatment,plan}` (falling
// back to the active provider only when those stages are themselves unassigned),
// so naming the registry's active provider here would misreport the processor on
// installs that assign the CD stages separately. Label it neutrally; the section
// helper text points the user at their Creative Director assignment.
function AssignmentPicker({ assignment, onChange }) {
  const [providers, setProviders] = useState([]);

  useEffect(() => {
    getProviders({ silent: true })
      .then((data) => setProviders((data?.providers || []).filter(isProcessProvider)))
      .catch(() => { /* dropdowns fall back to the "install default" option */ });
  }, []);

  const availableModels = useMemo(() => {
    const p = providers.find((x) => x.id === assignment.providerId);
    return p?.models || [];
  }, [providers, assignment.providerId]);

  return (
    <ProviderModelSelector
      providers={providers}
      selectedProviderId={assignment.providerId || ''}
      selectedModel={assignment.model || ''}
      availableModels={availableModels}
      onProviderChange={(id) => onChange({ providerId: id || '', model: '' })}
      onModelChange={(model) => onChange({ ...assignment, model: model || '' })}
      label="Provider"
      modelDisabled={availableModels.length === 0}
      alwaysShowModel
      highlightToolUse
      emptyProviderOption="Install default (Creative Director assignment)"
      emptyModelOption="Default model"
    />
  );
}
