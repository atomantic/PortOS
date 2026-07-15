import Drawer from '../Drawer';
import useDrawerTab from '../../hooks/useDrawerTab';
import { useCitySettingsContext } from './CitySettingsContext';
import { QUALITY_PRESETS } from '../../hooks/useCitySettings';

// City settings migrated onto the shared tabbed <Drawer> (issue #2591) — replaces
// the old bespoke bottom-right 19rem page-length scroller. Grouped into
// Performance / Audio / Visual / Explore so no single tab is a long scroll, with the
// active tab deep-linked through the `cityTab` URL param (useDrawerTab). All mutable
// state lives in CitySettingsContext ABOVE this remounting body, so switching tabs
// (which remounts the body) never drops an edit.

function SettingToggle({ id, label, value, onChange, description }) {
  return (
    <div className="flex items-center justify-between py-2 group" title={description}>
      <label htmlFor={id} className="font-pixel text-[11px] text-gray-300 tracking-wide cursor-pointer">
        {label}
      </label>
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={value}
        aria-label={label}
        onClick={() => onChange(!value)}
        className={`w-11 h-6 rounded-full relative transition-colors border ${value ? 'bg-cyan-500/40 border-cyan-500/60' : 'bg-gray-700/40 border-gray-600/40'}`}
      >
        <span
          className={`absolute top-0.5 w-4 h-4 rounded-full transition-all ${value ? 'left-[22px] bg-cyan-400 shadow-[0_0_6px_rgba(6,182,212,0.5)]' : 'left-[2px] bg-gray-500'}`}
        />
      </button>
    </div>
  );
}

function SettingSlider({ id, label, value, onChange, min = 0, max = 1, step = 0.05, format, description }) {
  const displayValue = format ? format(value) : `${Math.round(value * 100)}%`;
  return (
    <div className="py-2" title={description}>
      <div className="flex items-center justify-between mb-1.5">
        <label htmlFor={id} className="font-pixel text-[11px] text-gray-300 tracking-wide">{label}</label>
        <span className="font-pixel text-[10px] text-cyan-400/70">{displayValue}</span>
      </div>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        aria-label={label}
        className="w-full h-2 bg-gray-700 rounded-full appearance-none cursor-pointer accent-cyan-500"
        style={{
          background: `linear-gradient(to right, #06b6d4 0%, #06b6d4 ${(value - min) / (max - min) * 100}%, #374151 ${(value - min) / (max - min) * 100}%, #374151 100%)`,
        }}
      />
    </div>
  );
}

// Segmented enum picker. `isActive` defaults to strict equality; pass a predicate
// for legacy-value mapping.
function SettingSegment({ label, options, value, onChange, hint, isActive }) {
  const activeFor = isActive ?? ((key) => value === key);
  return (
    <div className="py-2">
      {label && <div className="font-pixel text-[11px] text-gray-300 tracking-wide mb-2">{label}</div>}
      <div className={`grid gap-1.5 ${options.length === 2 ? 'grid-cols-2' : 'grid-cols-3'}`} role="group" aria-label={label}>
        {options.map(({ key, label: optionLabel }) => (
          <button
            key={key}
            type="button"
            aria-pressed={activeFor(key)}
            onClick={() => onChange(key)}
            className={`font-pixel text-[10px] min-h-[44px] rounded border transition-all tracking-wide ${
              activeFor(key)
                ? 'bg-cyan-500/20 border-cyan-500/50 text-cyan-400 shadow-[0_0_8px_rgba(6,182,212,0.2)]'
                : 'bg-gray-800/40 border-gray-700/40 text-gray-400 hover:border-gray-600 hover:text-gray-300'
            }`}
          >
            {optionLabel}
          </button>
        ))}
      </div>
      {hint && <div className="font-pixel text-[8px] text-gray-500 tracking-wide mt-1.5">{hint}</div>}
    </div>
  );
}

function SectionHeader({ title, subtitle }) {
  return (
    <div className="mb-2">
      <div className="font-pixel text-[10px] text-cyan-500/70 tracking-wider">{title}</div>
      {subtitle && <div className="font-pixel text-[8px] text-gray-500 tracking-wide mt-0.5">{subtitle}</div>}
    </div>
  );
}

export const CITY_SETTINGS_TABS = [
  { id: 'performance', label: 'Performance' },
  { id: 'audio', label: 'Audio' },
  { id: 'visual', label: 'Visual' },
  { id: 'explore', label: 'Explore' },
];
const TAB_IDS = CITY_SETTINGS_TABS.map(t => t.id);

export default function CitySettingsDrawer({ open, onClose }) {
  const { settings, updateSetting, resetSettings } = useCitySettingsContext();
  const [activeTab, setActiveTab] = useDrawerTab('cityTab', 'performance', TAB_IDS);

  if (!open || !settings) return null;

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title="City Settings"
      size="sm"
      tabs={CITY_SETTINGS_TABS}
      activeTab={activeTab}
      onTabChange={setActiveTab}
      closeLabel="Close city settings"
    >
      {activeTab === 'performance' && (
        <div className="space-y-5">
          <div>
            <SectionHeader title="QUALITY PRESET" subtitle="Controls overall visual fidelity" />
            <div className="grid grid-cols-4 gap-1.5" role="group" aria-label="Quality preset">
              {Object.keys(QUALITY_PRESETS).map(preset => (
                <button
                  key={preset}
                  type="button"
                  aria-pressed={settings.qualityPreset === preset}
                  onClick={() => updateSetting('qualityPreset', preset)}
                  className={`font-pixel text-[10px] min-h-[44px] rounded border transition-all tracking-wide ${
                    settings.qualityPreset === preset
                      ? 'bg-cyan-500/20 border-cyan-500/50 text-cyan-400 shadow-[0_0_8px_rgba(6,182,212,0.2)]'
                      : 'bg-gray-800/40 border-gray-700/40 text-gray-400 hover:border-gray-600 hover:text-gray-300'
                  }`}
                >
                  {preset.toUpperCase()}
                </button>
              ))}
            </div>
          </div>
          <SettingSlider
            id="city-particle-density"
            label="PARTICLE DENSITY"
            value={settings.particleDensity}
            onChange={(v) => updateSetting('particleDensity', v)}
            min={0.25}
            max={2}
            step={0.25}
            description="Amount of floating particles in the scene"
          />
        </div>
      )}

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
              <SettingSlider
                id="city-music-volume"
                label="VOLUME"
                value={settings.musicVolume}
                onChange={(v) => updateSetting('musicVolume', v)}
                description="Music playback volume"
              />
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
            <SectionHeader title="VISUAL FX" subtitle="Reflections and atmosphere" />
            <SettingToggle
              id="city-reflections"
              label="REFLECTIONS"
              value={settings.reflectionsEnabled}
              onChange={(v) => updateSetting('reflectionsEnabled', v)}
              description="Wet street reflections and puddles"
            />
            <SettingToggle
              id="city-scanlines"
              label="SCANLINES"
              value={settings.scanlineOverlay}
              onChange={(v) => updateSetting('scanlineOverlay', v)}
              description="CRT monitor scanline overlay"
            />
          </div>
          <div>
            <SectionHeader title="SCENE LIGHTING" subtitle="Brightness and time of day" />
            <SettingSlider
              id="city-ambient-brightness"
              label="AMBIENT BRIGHTNESS"
              value={settings.ambientBrightness}
              onChange={(v) => updateSetting('ambientBrightness', v)}
              min={0.5}
              max={2.5}
              step={0.1}
              format={(v) => `${v.toFixed(1)}x`}
              description="Overall scene ambient light level"
            />
            <SettingSlider
              id="city-neon-brightness"
              label="NEON BRIGHTNESS"
              value={settings.neonBrightness}
              onChange={(v) => updateSetting('neonBrightness', v)}
              min={0.5}
              max={2.5}
              step={0.1}
              format={(v) => `${v.toFixed(1)}x`}
              description="Brightness of neon lights and building glow"
            />
            <SettingSegment
              label="TIME OF DAY"
              options={[
                { key: 'auto', label: 'AUTO' },
                { key: 'day', label: 'DAY' },
                { key: 'night', label: 'NIGHT' },
              ]}
              value={settings.timeOfDay}
              onChange={(key) => updateSetting('timeOfDay', key)}
              hint="AUTO FOLLOWS YOUR THEME (DAY / NIGHT)"
              isActive={(key) => (settings.timeOfDay === 'day' || settings.timeOfDay === 'night')
                ? settings.timeOfDay === key
                : key === 'auto'}
            />
          </div>
        </div>
      )}

      {activeTab === 'explore' && (
        <div className="space-y-5">
          <div>
            <SectionHeader title="EXPLORATION" subtitle="Street-level character mode" />
            <SettingToggle
              id="city-exploration-mode"
              label="DROP IN MODE"
              value={settings.explorationMode}
              onChange={(v) => updateSetting('explorationMode', v)}
              description="Toggle street-level exploration (Tab)"
            />
            <SettingSegment
              options={[
                { key: 'third', label: 'CHARACTER' },
                { key: 'first', label: 'FIRST PERSON' },
              ]}
              value={settings.cameraView ?? 'third'}
              onChange={(key) => updateSetting('cameraView', key)}
              hint="CAMERA WHILE EXPLORING (V SWAPS IN-WORLD)"
            />
          </div>
          <button
            type="button"
            onClick={resetSettings}
            className="w-full font-pixel text-[10px] min-h-[44px] rounded border border-port-error/30 text-port-error/70 hover:bg-port-error/10 hover:text-port-error transition-all tracking-wider"
          >
            RESET DEFAULTS
          </button>
        </div>
      )}
    </Drawer>
  );
}
