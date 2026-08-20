import Drawer from '../Drawer';
import useDrawerTab from '../../hooks/useDrawerTab';
import { useOpenWorldSettingsContext } from './OpenWorldSettingsContext';
import { SOUNDSCAPE_MOODS, isSoundscapeMood } from '../../utils/openWorldSoundscape';
import { WORLD_STYLE_DEFS, WORLD_STYLES, resolveWorldStyle } from './openWorldConstants';

// Derived from the style table, so registering a style makes it pickable — no second list.
const WORLD_STYLE_OPTIONS = WORLD_STYLES.map((key) => ({ key, label: WORLD_STYLE_DEFS[key].label }));

// The soundscape override's "no override" option. A <select> cannot carry null, so the
// auto choice rides as the empty string and the change handler maps it back to the null
// sentinel — keeping "following live state" distinct from "pinned to a mood".
const SOUNDSCAPE_AUTO = '';
const SOUNDSCAPE_OPTIONS = [
  { value: SOUNDSCAPE_AUTO, label: 'AUTO' },
  ...SOUNDSCAPE_MOODS.map(mood => ({ value: mood, label: mood.toUpperCase() })),
];

// OpenWorld settings stay on the shared Drawer, but the surface is intentionally small:
// world style, sound, and controls are player choices. Render quality, scanlines, reflections,
// and brightness sliders were implementation leftovers from earlier versions of the world and
// are now resolved by the scene's art direction and adaptive renderer.

function SettingToggle({ id, label, value, onChange, description, disabled = false }) {
  return (
    <div className={`flex items-center justify-between py-2 group ${disabled ? 'opacity-40' : ''}`} title={description}>
      <label htmlFor={id} className={`font-sans text-[12px] text-gray-300 tracking-wide ${disabled ? 'cursor-not-allowed' : 'cursor-pointer'}`}>
        {label}
      </label>
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={value}
        aria-label={label}
        disabled={disabled}
        onClick={() => !disabled && onChange(!value)}
        className={`w-11 h-6 rounded-full relative transition-colors border ${value ? 'bg-cyan-500/40 border-cyan-500/60' : 'bg-gray-700/40 border-gray-600/40'} ${disabled ? 'cursor-not-allowed' : ''}`}
      >
        <span
          className={`absolute top-0.5 w-4 h-4 rounded-full transition-all ${value ? 'left-[22px] bg-cyan-400 shadow-[0_0_6px_rgba(6,182,212,0.5)]' : 'left-[2px] bg-gray-500'}`}
        />
      </button>
    </div>
  );
}

function SettingSlider({ id, label, value, onChange, min = 0, max = 1, step = 0.05, format, description, disabled = false }) {
  const displayValue = format ? format(value) : `${Math.round(value * 100)}%`;
  return (
    <div className={`py-2 ${disabled ? 'opacity-40' : ''}`} title={description}>
      <div className="flex items-center justify-between mb-1.5">
        <label htmlFor={id} className="font-sans text-[12px] text-gray-300 tracking-wide">{label}</label>
        <span className="font-mono text-[11px] text-cyan-400/70">{displayValue}</span>
      </div>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        aria-label={label}
        className={`w-full h-2 bg-gray-700 rounded-full appearance-none accent-cyan-500 ${disabled ? 'cursor-not-allowed' : 'cursor-pointer'}`}
        style={{
          background: `linear-gradient(to right, #06b6d4 0%, #06b6d4 ${(value - min) / (max - min) * 100}%, #374151 ${(value - min) / (max - min) * 100}%, #374151 100%)`,
        }}
      />
    </div>
  );
}

// Dropdown enum picker, for enums with too many options to read as a segmented row.
// `options` is [{ value, label }]; values are plain strings (the caller maps any sentinel).
function SettingSelect({ id, label, value, onChange, options, hint, description }) {
  return (
    <div className="py-2" title={description}>
      <label htmlFor={id} className="block font-sans text-[12px] text-gray-300 tracking-wide mb-1.5">{label}</label>
      <select
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full font-sans text-[12px] min-h-[44px] px-2 rounded border border-gray-700/40 bg-gray-800/40 text-gray-300 tracking-wide focus:border-cyan-500/50 focus:outline-none"
      >
        {options.map(({ value: optionValue, label: optionLabel }) => (
          <option key={optionValue} value={optionValue}>{optionLabel}</option>
        ))}
      </select>
      {hint && <div className="font-mono text-[10px] text-gray-500 tracking-wide mt-1.5">{hint}</div>}
    </div>
  );
}

// Segmented enum picker. `isActive` defaults to strict equality; pass a predicate
// for legacy-value mapping.
function SettingSegment({ label, options, value, onChange, hint, isActive }) {
  const activeFor = isActive ?? ((key) => value === key);
  return (
    <div className="py-2">
      {label && <div className="font-sans text-[12px] text-gray-300 tracking-wide mb-2">{label}</div>}
      <div className={`grid gap-1.5 ${options.length === 2 ? 'grid-cols-2' : 'grid-cols-3'}`} role="group" aria-label={label}>
        {options.map(({ key, label: optionLabel }) => (
          <button
            key={key}
            type="button"
            aria-pressed={activeFor(key)}
            onClick={() => onChange(key)}
            className={`font-sans text-[11px] min-h-[44px] rounded border transition-all tracking-wide ${
              activeFor(key)
                ? 'bg-cyan-500/20 border-cyan-500/50 text-cyan-400 shadow-[0_0_8px_rgba(6,182,212,0.2)]'
                : 'bg-gray-800/40 border-gray-700/40 text-gray-400 hover:border-gray-600 hover:text-gray-300'
            }`}
          >
            {optionLabel}
          </button>
        ))}
      </div>
      {hint && <div className="font-mono text-[10px] text-gray-500 tracking-wide mt-1.5">{hint}</div>}
    </div>
  );
}

function SectionHeader({ title, subtitle }) {
  return (
    <div className="mb-2">
      <div className="font-mono text-[10px] font-semibold text-cyan-500/70 tracking-[0.14em]">{title}</div>
      {subtitle && <div className="font-sans text-[11px] text-gray-500 tracking-wide mt-0.5">{subtitle}</div>}
    </div>
  );
}

function KeyCaps({ keys }) {
  return (
    <span className="flex shrink-0 items-center gap-1" aria-label={keys.join(' / ')}>
      {keys.map(key => (
        <kbd key={key} className="inline-flex min-w-[28px] min-h-[26px] items-center justify-center rounded-md border border-cyan-500/25 bg-cyan-500/[0.08] px-1.5 font-mono text-[10px] font-semibold text-cyan-300">
          {key}
        </kbd>
      ))}
    </span>
  );
}

function ControlRow({ keys, label, hint }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-gray-700/30 py-2.5 last:border-b-0">
      <div className="min-w-0">
        <div className="font-sans text-[12px] text-gray-200">{label}</div>
        {hint && <div className="font-sans text-[10px] text-gray-500 mt-0.5">{hint}</div>}
      </div>
      <KeyCaps keys={keys} />
    </div>
  );
}

export const CITY_SETTINGS_TABS = [
  { id: 'audio', label: 'Audio' },
  { id: 'visual', label: 'Visual' },
  { id: 'controls', label: 'Controls' },
];
const TAB_IDS = CITY_SETTINGS_TABS.map(t => t.id);

export default function OpenWorldSettingsDrawer({ open, onClose }) {
  const { settings, updateSetting, resetSettings } = useOpenWorldSettingsContext();
  const [activeTab, setActiveTab] = useDrawerTab('openWorldTab', 'audio', TAB_IDS);

  if (!open || !settings) return null;

  const worldStyle = resolveWorldStyle(settings.worldStyle);
  const isCyberCity = worldStyle === 'cyber';

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title="OpenWorld Settings"
      size="sm"
      tabs={CITY_SETTINGS_TABS}
      activeTab={activeTab}
      onTabChange={setActiveTab}
      closeLabel="Close city settings"
      // Drawer portals to <body>, so re-apply the page scope for the themed panel and its
      // typography. The extra hook is useful for drawer-only spacing without touching all HUD.
      portalClassName="openworld-themed openworld-settings-portal"
    >
      {activeTab === 'audio' && (
        <div className="space-y-5">
          <div>
            <SectionHeader title="MUSIC" subtitle="Procedural synthwave background" />
            <SettingToggle
              id="city-music-enabled"
              label="SYNTHWAVE"
              value={settings.musicEnabled}
              onChange={(v) => updateSetting('musicEnabled', v)}
              description="Enable ambient synthwave music"
            />
            {settings.musicEnabled && (
              <>
                <SettingSlider
                  id="city-music-volume"
                  label="VOLUME"
                  value={settings.musicVolume}
                  onChange={(v) => updateSetting('musicVolume', v)}
                  description="Music playback volume"
                />
                <SettingSelect
                  id="city-soundscape-override"
                  label="SOUNDSCAPE"
                  value={isSoundscapeMood(settings.soundscapeOverride) ? settings.soundscapeOverride : SOUNDSCAPE_AUTO}
                  onChange={(v) => updateSetting('soundscapeOverride', v === SOUNDSCAPE_AUTO ? null : v)}
                  options={SOUNDSCAPE_OPTIONS}
                  hint="AUTO FOLLOWS SYSTEM HEALTH AND AGENT ACTIVITY"
                  description="Pin the ambient music's mood, or follow live system state"
                />
              </>
            )}
          </div>
          <div>
            <SectionHeader title="SOUND FX" subtitle="UI and environment sounds" />
            <SettingToggle
              id="city-sfx-enabled"
              label="ENABLED"
              value={settings.sfxEnabled}
              onChange={(v) => updateSetting('sfxEnabled', v)}
              description="Enable sound effects for interactions"
            />
            {settings.sfxEnabled && (
              <SettingSlider
                id="city-sfx-volume"
                label="VOLUME"
                value={settings.sfxVolume}
                onChange={(v) => updateSetting('sfxVolume', v)}
                description="Sound effects volume"
              />
            )}
          </div>
        </div>
      )}

      {activeTab === 'visual' && (
        <div className="space-y-5">
          <div>
            <SectionHeader title="WORLD" subtitle="Choose the world’s art direction" />
            <SettingSegment
              label="WORLD STYLE"
              options={WORLD_STYLE_OPTIONS}
              value={worldStyle}
              onChange={(key) => updateSetting('worldStyle', key)}
              hint="OPEN WORLD IS BRIGHT AND LOW-POLY; CYBER CITY IS NEON AFTER DARK"
            />
          </div>
          <div>
            <SectionHeader title="TIME" subtitle={isCyberCity ? 'Cyber City keeps its nocturnal identity' : 'Open World can follow your PortOS theme'} />
            {isCyberCity ? (
              <div className="rounded-xl border border-cyan-500/20 bg-cyan-500/[0.06] px-3 py-3">
                <div className="font-mono text-[10px] font-semibold tracking-[0.14em] text-cyan-300">ALWAYS NIGHT</div>
                <p className="mt-1 font-sans text-[11px] leading-5 text-gray-400">Neon materials and the moonlit sky are designed as one scene, so daylight is not offered in this style.</p>
              </div>
            ) : (
              <SettingSegment
                label="TIME OF DAY"
                options={[
                  { key: 'auto', label: 'AUTO' },
                  { key: 'day', label: 'DAY' },
                  { key: 'night', label: 'NIGHT' },
                ]}
                value={settings.timeOfDay}
                onChange={(key) => updateSetting('timeOfDay', key)}
                hint="AUTO FOLLOWS YOUR PORTOS THEME"
                isActive={(key) => (settings.timeOfDay === 'day' || settings.timeOfDay === 'night')
                  ? settings.timeOfDay === key
                  : key === 'auto'}
              />
            )}
          </div>
          <div className="rounded-xl border border-gray-700/35 bg-black/10 px-3 py-3">
            <div className="font-sans text-[12px] text-gray-200">A focused visual language</div>
            <p className="mt-1 font-sans text-[11px] leading-5 text-gray-500">The renderer now adapts detail automatically. The scene keeps its lighting, ground, and atmosphere coherent on every tier.</p>
          </div>
        </div>
      )}

      {activeTab === 'controls' && (
        <div className="space-y-5">
          <div>
            <SectionHeader title="PLAY MODE" subtitle="Switch between the map and street level" />
            <SettingToggle
              id="city-exploration-mode"
              label="DROP IN MODE"
              value={settings.explorationMode}
              onChange={(v) => updateSetting('explorationMode', v)}
              description="Toggle street-level exploration (Tab)"
            />
            <SettingSegment
              label="CAMERA"
              options={[
                { key: 'third', label: 'ROVER' },
                { key: 'first', label: 'FIRST PERSON' },
              ]}
              value={settings.cameraView ?? 'third'}
              onChange={(key) => updateSetting('cameraView', key)}
              hint="V SWITCHES CAMERA WHILE EXPLORING"
            />
          </div>
          <div>
            <SectionHeader title="MOVEMENT" subtitle="Keyboard and mouse controls" />
            <div className="rounded-xl border border-gray-700/35 bg-black/10 px-3">
              <ControlRow keys={['W', 'A', 'S', 'D']} label="Move" hint="Arrow keys also work" />
              <ControlRow keys={['SHIFT']} label="Boost" />
              <ControlRow keys={['SPACE']} label="Jump" />
              <ControlRow keys={['E', 'Q']} label="Fly up / down" hint="Free-fly vertical movement" />
              <ControlRow keys={['F']} label="Interact" hint="Buildings and warp pads" />
              <ControlRow keys={['R']} label="Respawn" hint="Return to your drop-in point" />
              <ControlRow keys={['V']} label="Switch camera" />
              <ControlRow keys={['TAB']} label="Drop in / fly out" />
              <ControlRow keys={['M']} label="World map" />
              <ControlRow keys={['DRAG']} label="Look around" hint="Click the scene to capture the mouse" />
            </div>
          </div>
          <button
            type="button"
            onClick={resetSettings}
            className="w-full font-sans text-[12px] min-h-[44px] rounded border border-port-error/30 text-port-error/70 hover:bg-port-error/10 hover:text-port-error transition-all tracking-wider"
          >
            RESET DEFAULTS
          </button>
        </div>
      )}
    </Drawer>
  );
}
