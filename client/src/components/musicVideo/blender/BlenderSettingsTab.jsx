import BlenderDiskUse from './BlenderDiskUse.jsx';
import BlenderFilmOptions from './BlenderFilmOptions.jsx';
import BlenderReadiness from './BlenderReadiness.jsx';
import BlenderSyncControl from './BlenderSyncControl.jsx';
import BlenderWorkspace from './BlenderWorkspace.jsx';
import { BLENDER_ENGINES, BLENDER_SETTING_LIMITS, blenderSettingsProblems } from '../../../lib/musicVideoBlender.js';
import { buttonCls, inputCls, labelCls, primaryCls } from './blenderStyles.js';

const SIZE_PRESETS = [
  ['1920x1080', '1080p (1920 × 1080)'],
  ['1280x720', '720p (1280 × 720)'],
  ['3840x2160', '4K UHD (3840 × 2160)'],
  ['1080x1920', 'Vertical (1080 × 1920)'],
  ['1080x1080', 'Square (1080 × 1080)'],
];
const NUMBER_FIELDS = [
  ['width', 'Width (px)'],
  ['height', 'Height (px)'],
  ['fps', 'Frame rate (fps)'],
  ['previewScale', 'Preview scale'],
  ['previewSamples', 'Preview samples'],
  ['finalSamples', 'Final samples'],
  ['concurrency', 'Parallel renders'],
];
const even = (value) => Math.max(2, Math.round(value / 2) * 2);

/**
 * How the film renders (engine, frame size and rate, preview and final
 * quality, parallel Blender processes, saving each shot's .blend), saved
 * explicitly: Save sends only the fields that changed, and syncs and renders
 * wait until the form is saved or discarded. Below it: the shot sync, the
 * workspace and agent brief, and Blender setup.
 */
export default function BlenderSettingsTab({ blender }) {
  const { settings, settingsDirty, settingsSaving } = blender;
  const problems = blenderSettingsProblems(settings);
  const invalid = Object.keys(problems).length > 0 || (blender.optionFields || []).some((field) => field.problem);
  const preset = SIZE_PRESETS.find(([value]) => value === `${settings.width}x${settings.height}`)?.[0] || '';
  const previewSize = Number.isFinite(settings.width) && Number.isFinite(settings.height) && Number.isFinite(settings.previewScale)
    ? `${even(settings.width * settings.previewScale)} × ${even(settings.height * settings.previewScale)}`
    : null;

  return (
    <div className="min-w-0 space-y-4">
      <div role="group" aria-label="Render settings" className="min-w-0 space-y-2">
        <div className="grid min-w-0 grid-cols-[repeat(auto-fit,minmax(min(100%,9.5rem),1fr))] gap-2">
          <div className="min-w-0">
            <label htmlFor="mv-blender-engine" className={labelCls}>Engine</label>
            <select id="mv-blender-engine" value={settings.engine || ''} disabled={settingsSaving} className={inputCls}
              onChange={(event) => blender.editSettings({ engine: event.target.value })}>
              {BLENDER_ENGINES.map((engine) => <option key={engine.id} value={engine.id}>{engine.label}</option>)}
            </select>
          </div>
          <div className="min-w-0">
            <label htmlFor="mv-blender-size-preset" className={labelCls}>Frame size</label>
            <select id="mv-blender-size-preset" value={preset} disabled={settingsSaving} className={inputCls}
              onChange={(event) => {
                const [width, height] = event.target.value.split('x').map(Number);
                if (width && height) blender.editSettings({ width, height });
              }}>
              <option value="">Custom</option>
              {SIZE_PRESETS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </div>
          {NUMBER_FIELDS.map(([field, label]) => {
            const limit = BLENDER_SETTING_LIMITS[field];
            return (
              <div key={field} className="min-w-0">
                <label htmlFor={`mv-blender-${field}`} className={labelCls}>{label}</label>
                <input id={`mv-blender-${field}`} type="number" inputMode={limit.integer || limit.even ? 'numeric' : 'decimal'}
                  min={limit.min} max={limit.max} step={limit.step} disabled={settingsSaving}
                  value={Number.isFinite(settings[field]) ? settings[field] : ''}
                  aria-invalid={problems[field] ? true : undefined}
                  aria-describedby={problems[field] ? `mv-blender-${field}-problem` : undefined}
                  onChange={(event) => blender.editSettings({ [field]: event.target.value === '' ? Number.NaN : Number(event.target.value) })}
                  className={inputCls} />
                {problems[field] && <p id={`mv-blender-${field}-problem`} role="alert" className="mt-0.5 text-xs text-port-error">{problems[field]}</p>}
              </div>
            );
          })}
        </div>
        <label htmlFor="mv-blender-save-blend" className="flex min-h-[44px] items-center gap-1.5 text-sm pointer-fine:sm:min-h-0">
          <input id="mv-blender-save-blend" type="checkbox" checked={!!settings.saveBlend} disabled={settingsSaving}
            onChange={(event) => blender.editSettings({ saveBlend: event.target.checked })} />
          Save each shot&apos;s .blend when it renders (needed for Open in Blender)
        </label>
        <p className="text-xs text-port-text-muted">
          {BLENDER_ENGINES.find((engine) => engine.id === settings.engine)?.note} {previewSize ? `Previews render at ${previewSize}. ` : ''}
          Changing the engine, size, frame rate, preview scale or samples marks the renders made with the old values out of date.
        </p>
        <BlenderFilmOptions blender={blender} />
        <div className="flex flex-wrap items-center gap-1.5">
          <button type="button" className={primaryCls} disabled={!settingsDirty || invalid || settingsSaving} onClick={() => blender.saveSettings()}>
            {settingsSaving ? 'Saving…' : 'Save settings'}
          </button>
          {settingsDirty && !settingsSaving && <button type="button" className={buttonCls} onClick={blender.discardSettings}>Discard changes</button>}
          {settingsDirty && !settingsSaving && <span role="status" className="text-xs text-port-warning">Unsaved changes. Syncs and renders wait until they are saved.</span>}
        </div>
      </div>

      <section aria-label="Shot list" className="min-w-0 space-y-1.5 border-t border-port-border pt-3">
        <h4 className="text-sm font-medium">Shot list</h4>
        <p className="text-xs text-port-text-muted">The scripts are the source of truth for the shots. A sync lists them here and mirrors them to the storyboard.</p>
        <BlenderSyncControl blender={blender} />
      </section>

      <div className="border-t border-port-border pt-3">
        <BlenderWorkspace blender={blender} lead={<h4 className="text-sm font-medium">Workspace</h4>} />
      </div>

      <div className="border-t border-port-border pt-3">
        <BlenderDiskUse blender={blender} />
      </div>

      <div className="space-y-1.5 border-t border-port-border pt-3">
        <h4 className="text-sm font-medium">Blender</h4>
        <BlenderReadiness blender={blender} />
      </div>
    </div>
  );
}
