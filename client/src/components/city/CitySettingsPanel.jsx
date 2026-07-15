import { useNavigate } from 'react-router-dom';
import { useCitySettingsContext } from './CitySettingsContext';
import { QUALITY_PRESETS } from '../../hooks/useCitySettings';

function HudCorner({ position = 'tl', color = 'cyan' }) {
  const corners = {
    tl: 'top-0 left-0 border-t border-l',
    tr: 'top-0 right-0 border-t border-r',
    bl: 'bottom-0 left-0 border-b border-l',
    br: 'bottom-0 right-0 border-b border-r',
  };
  return (
    <div
      className={`absolute w-2 h-2 ${corners[position]} border-${color}-400/60`}
      style={{ borderWidth: '1px' }}
    />
  );
}

function SettingToggle({ label, value, onChange, description, disabled = false }) {
  return (
    <div className={`flex items-center justify-between py-1.5 group ${disabled ? 'opacity-40' : ''}`} title={description}>
      <span className="font-pixel text-[10px] text-gray-400 tracking-wide group-hover:text-gray-300 transition-colors">
        {label}
      </span>
      <button
        onClick={() => !disabled && onChange(!value)}
        disabled={disabled}
        className={`w-9 h-5 rounded-full relative transition-colors ${value ? 'bg-cyan-500/40 border-cyan-500/60' : 'bg-gray-700/40 border-gray-600/40'} border ${disabled ? 'cursor-not-allowed' : ''}`}
      >
        <div
          className={`absolute top-0.5 w-3 h-3 rounded-full transition-all ${value ? 'left-[16px] bg-cyan-400 shadow-[0_0_6px_rgba(6,182,212,0.5)]' : 'left-[2px] bg-gray-500'}`}
        />
      </button>
    </div>
  );
}

function SettingSlider({ label, value, onChange, min = 0, max = 1, step = 0.05, format, description, disabled = false }) {
  const displayValue = format
    ? format(value)
    : `${Math.round(value * 100)}%`;
  return (
    <div className={`py-1.5 ${disabled ? 'opacity-40' : ''}`} title={description}>
      <div className="flex items-center justify-between mb-1">
        <span className="font-pixel text-[10px] text-gray-400 tracking-wide">{label}</span>
        <span className="font-pixel text-[10px] text-cyan-400/70">{displayValue}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className={`w-full h-1.5 bg-gray-700 rounded-full appearance-none accent-cyan-500 ${disabled ? 'cursor-not-allowed' : 'cursor-pointer'}`}
        style={{
          background: `linear-gradient(to right, #06b6d4 0%, #06b6d4 ${(value - min) / (max - min) * 100}%, #374151 ${(value - min) / (max - min) * 100}%, #374151 100%)`,
        }}
      />
    </div>
  );
}

// Segmented enum picker — one glowing button per option, with an optional hint line.
// `isActive` defaults to strict equality; pass a predicate for legacy-value mapping.
function SettingSegment({ label, options, value, onChange, hint, isActive }) {
  const activeFor = isActive ?? ((key) => value === key);
  return (
    <div className="py-1.5">
      {label && <div className="font-pixel text-[10px] text-gray-400 tracking-wide mb-2">{label}</div>}
      <div className={`grid gap-1.5 ${options.length === 2 ? 'grid-cols-2' : 'grid-cols-3'}`}>
        {options.map(({ key, label: optionLabel }) => (
          <button
            key={key}
            onClick={() => onChange(key)}
            className={`font-pixel text-[9px] py-2 rounded border transition-all tracking-wide ${
              activeFor(key)
                ? 'bg-cyan-500/20 border-cyan-500/50 text-cyan-400 shadow-[0_0_8px_rgba(6,182,212,0.2)]'
                : 'bg-gray-800/40 border-gray-700/40 text-gray-500 hover:border-gray-600 hover:text-gray-400'
            }`}
          >
            {optionLabel}
          </button>
        ))}
      </div>
      {hint && <div className="font-pixel text-[8px] text-gray-600 tracking-wide mt-1.5">{hint}</div>}
    </div>
  );
}

function SectionHeader({ title, subtitle }) {
  return (
    <div className="mb-2">
      <div className="font-pixel text-[10px] text-cyan-500/70 tracking-wider">{title}</div>
      {subtitle && (
        <div className="font-pixel text-[8px] text-gray-600 tracking-wide mt-0.5">{subtitle}</div>
      )}
    </div>
  );
}

// Format a diagnostics number, guarding the not-yet-measured (null) case.
function fmt(value, digits = 0) {
  return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(digits) : '—';
}

export default function CitySettingsPanel({ qualityMode = 'manual', effectiveTier = 'high', diagnostics = null }) {
  const navigate = useNavigate();
  const { settings, updateSetting, resetSettings } = useCitySettingsContext();

  if (!settings) return null;

  const isAuto = qualityMode === 'auto';
  const modeLabel = isAuto
    ? `AUTO · ${String(effectiveTier).toUpperCase()}`
    : `MANUAL · ${String(settings.qualityPreset || 'high').toUpperCase()}`;

  const setQuality = (key) => {
    // 'auto' engages the adaptive budget; a named preset pins Manual (handled in the hook).
    if (key === 'auto') updateSetting('qualityMode', 'auto');
    else updateSetting('qualityPreset', key);
  };

  return (
    <div className="absolute bottom-4 right-4 z-50 pointer-events-auto animate-in slide-in-from-bottom-4 duration-300">
      <div
        className="relative bg-black/92 backdrop-blur-md border border-cyan-500/35 rounded-lg w-76 max-h-[80vh] overflow-y-auto"
        style={{ scrollbarWidth: 'thin', scrollbarColor: 'rgba(6,182,212,0.2) transparent', width: '19rem' }}
      >
        <HudCorner position="tl" />
        <HudCorner position="tr" />
        <HudCorner position="bl" />
        <HudCorner position="br" />

        {/* Header */}
        <div className="sticky top-0 z-10 bg-black/95 flex items-center justify-between px-4 py-3 border-b border-cyan-500/25">
          <span className="font-pixel text-[12px] text-cyan-400 tracking-widest" style={{ textShadow: '0 0 8px rgba(6,182,212,0.4)' }}>
            SETTINGS
          </span>
          <button
            onClick={() => navigate('/city')}
            className="font-pixel text-[11px] text-gray-500 hover:text-cyan-400 transition-colors tracking-wide w-8 h-8 flex items-center justify-center rounded hover:bg-cyan-500/10"
          >
            [X]
          </button>
        </div>

        <div className="px-4 py-3 space-y-5">
          {/* Quality */}
          <div>
            <SectionHeader title="QUALITY" subtitle={modeLabel} />
            {/* AUTO adapts the effective tier to sustained frame pressure. */}
            <button
              onClick={() => setQuality('auto')}
              className={`w-full font-pixel text-[9px] py-2 mb-1.5 rounded border transition-all tracking-wide ${
                isAuto
                  ? 'bg-cyan-500/20 border-cyan-500/50 text-cyan-400 shadow-[0_0_8px_rgba(6,182,212,0.2)]'
                  : 'bg-gray-800/40 border-gray-700/40 text-gray-500 hover:border-gray-600 hover:text-gray-400'
              }`}
            >
              AUTO {isAuto ? `· ${String(effectiveTier).toUpperCase()}` : ''}
            </button>
            <div className="grid grid-cols-4 gap-1.5">
              {Object.keys(QUALITY_PRESETS).map(preset => (
                <button
                  key={preset}
                  onClick={() => setQuality(preset)}
                  className={`font-pixel text-[9px] py-2 rounded border transition-all tracking-wide ${
                    !isAuto && settings.qualityPreset === preset
                      ? 'bg-cyan-500/20 border-cyan-500/50 text-cyan-400 shadow-[0_0_8px_rgba(6,182,212,0.2)]'
                      : 'bg-gray-800/40 border-gray-700/40 text-gray-500 hover:border-gray-600 hover:text-gray-400'
                  }`}
                >
                  {preset.toUpperCase()}
                </button>
              ))}
            </div>
            {/* Local-only diagnostics — never persisted or transmitted (issue #2592). */}
            {isAuto && (
              <div className="mt-2 px-2 py-1.5 rounded bg-black/40 border border-cyan-500/10 font-pixel text-[8px] text-gray-500 tracking-wide flex items-center justify-between">
                <span>TIER <span className="text-cyan-400/70">{String(effectiveTier).toUpperCase()}</span></span>
                <span>{fmt(diagnostics?.fps)} FPS</span>
                <span>P75 {fmt(diagnostics?.p75, 1)}ms</span>
              </div>
            )}
          </div>

          <div className="border-t border-cyan-500/10" />

          {/* Music */}
          <div>
            <SectionHeader title="MUSIC" subtitle="Procedural synthwave background" />
            <SettingToggle
              label="SYNTHWAVE"
              value={settings.musicEnabled}
              onChange={(v) => updateSetting('musicEnabled', v)}
              description="Enable ambient synthwave music"
            />
            {settings.musicEnabled && (
              <SettingSlider
                label="VOLUME"
                value={settings.musicVolume}
                onChange={(v) => updateSetting('musicVolume', v)}
                description="Music playback volume"
              />
            )}
          </div>

          {/* Sound Effects */}
          <div>
            <SectionHeader title="SOUND FX" subtitle="UI and environment sounds" />
            <SettingToggle
              label="ENABLED"
              value={settings.sfxEnabled}
              onChange={(v) => updateSetting('sfxEnabled', v)}
              description="Enable sound effects for interactions"
            />
            {settings.sfxEnabled && (
              <SettingSlider
                label="VOLUME"
                value={settings.sfxVolume}
                onChange={(v) => updateSetting('sfxVolume', v)}
                description="Sound effects volume"
              />
            )}
          </div>

          <div className="border-t border-cyan-500/10" />

          {/* Visual Effects */}
          <div>
            <SectionHeader title="VISUAL FX" subtitle={isAuto ? 'Reflections + density controlled by Auto' : 'Reflections and atmosphere'} />
            <SettingToggle
              label="REFLECTIONS"
              value={settings.reflectionsEnabled}
              onChange={(v) => updateSetting('reflectionsEnabled', v)}
              description={isAuto ? 'Set automatically by Auto quality' : 'Wet street reflections and puddles'}
              disabled={isAuto}
            />
            <SettingToggle
              label="SCANLINES"
              value={settings.scanlineOverlay}
              onChange={(v) => updateSetting('scanlineOverlay', v)}
              description="CRT monitor scanline overlay"
            />
            <SettingSlider
              label="PARTICLE DENSITY"
              value={settings.particleDensity}
              onChange={(v) => updateSetting('particleDensity', v)}
              min={0.25}
              max={2}
              step={0.25}
              description={isAuto ? 'Set automatically by Auto quality' : 'Amount of floating particles in the scene'}
              disabled={isAuto}
            />
          </div>

          <div className="border-t border-cyan-500/10" />

          {/* Scene Lighting */}
          <div>
            <SectionHeader title="SCENE LIGHTING" subtitle="Brightness and time of day" />
            <SettingSlider
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
              // Legacy presets (sunrise/noon/sunset/midnight) read as Auto now.
              isActive={(key) => (settings.timeOfDay === 'day' || settings.timeOfDay === 'night')
                ? settings.timeOfDay === key
                : key === 'auto'}
            />
          </div>

          <div className="border-t border-cyan-500/10" />

          {/* Exploration */}
          <div>
            <SectionHeader title="EXPLORATION" subtitle="Street-level character mode" />
            <SettingToggle
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

          <div className="border-t border-cyan-500/10" />

          {/* Reset */}
          <button
            onClick={resetSettings}
            className="w-full font-pixel text-[10px] py-2 rounded border border-port-error/30 text-port-error/60 hover:bg-port-error/10 hover:text-port-error transition-all tracking-wider"
          >
            RESET DEFAULTS
          </button>
        </div>
      </div>
    </div>
  );
}
