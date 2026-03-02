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

function SettingToggle({ label, value, onChange, description }) {
  return (
    <div className="flex items-center justify-between py-1.5 group" title={description}>
      <span className="font-pixel text-[10px] text-gray-400 tracking-wide group-hover:text-gray-300 transition-colors">
        {label}
      </span>
      <button
        onClick={() => onChange(!value)}
        className={`w-9 h-5 rounded-full relative transition-colors ${value ? 'bg-cyan-500/40 border-cyan-500/60' : 'bg-gray-700/40 border-gray-600/40'} border`}
      >
        <div
          className={`absolute top-0.5 w-3 h-3 rounded-full transition-all ${value ? 'left-[16px] bg-cyan-400 shadow-[0_0_6px_rgba(6,182,212,0.5)]' : 'left-[2px] bg-gray-500'}`}
        />
      </button>
    </div>
  );
}

function SettingSlider({ label, value, onChange, min = 0, max = 1, step = 0.05, format, description }) {
  const displayValue = format
    ? format(value)
    : `${Math.round(value * 100)}%`;
  return (
    <div className="py-1.5" title={description}>
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
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="w-full h-1.5 bg-gray-700 rounded-full appearance-none cursor-pointer accent-cyan-500"
        style={{
          background: `linear-gradient(to right, #06b6d4 0%, #06b6d4 ${(value - min) / (max - min) * 100}%, #374151 ${(value - min) / (max - min) * 100}%, #374151 100%)`,
        }}
      />
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

export default function CitySettingsPanel() {
  const navigate = useNavigate();
  const { settings, updateSetting, resetSettings } = useCitySettingsContext();

  if (!settings) return null;

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
          {/* Quality Preset */}
          <div>
            <SectionHeader title="QUALITY PRESET" subtitle="Controls overall visual fidelity" />
            <div className="grid grid-cols-4 gap-1.5">
              {Object.keys(QUALITY_PRESETS).map(preset => (
                <button
                  key={preset}
                  onClick={() => updateSetting('qualityPreset', preset)}
                  className={`font-pixel text-[9px] py-2 rounded border transition-all tracking-wide ${
                    settings.qualityPreset === preset
                      ? 'bg-cyan-500/20 border-cyan-500/50 text-cyan-400 shadow-[0_0_8px_rgba(6,182,212,0.2)]'
                      : 'bg-gray-800/40 border-gray-700/40 text-gray-500 hover:border-gray-600 hover:text-gray-400'
                  }`}
                >
                  {preset.toUpperCase()}
                </button>
              ))}
            </div>
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
            <SectionHeader title="VISUAL FX" subtitle="Post-processing and atmosphere" />
            <SettingToggle
              label="BLOOM"
              value={settings.bloomEnabled}
              onChange={(v) => updateSetting('bloomEnabled', v)}
              description="Glowing light bloom around bright surfaces"
            />
            {settings.bloomEnabled && (
              <SettingSlider
                label="STRENGTH"
                value={settings.bloomStrength}
                onChange={(v) => updateSetting('bloomStrength', v)}
                description="Intensity of the bloom glow effect"
              />
            )}
            <SettingToggle
              label="REFLECTIONS"
              value={settings.reflectionsEnabled}
              onChange={(v) => updateSetting('reflectionsEnabled', v)}
              description="Wet street reflections and puddles"
            />
            <SettingToggle
              label="CHROMATIC ABERRATION"
              value={settings.chromaticAberration}
              onChange={(v) => updateSetting('chromaticAberration', v)}
              description="Color fringing at screen edges"
            />
            <SettingToggle
              label="FILM GRAIN"
              value={settings.filmGrain}
              onChange={(v) => updateSetting('filmGrain', v)}
              description="Subtle animated noise overlay"
            />
            <SettingToggle
              label="COLOR GRADING"
              value={settings.colorGrading}
              onChange={(v) => updateSetting('colorGrading', v)}
              description="Cinematic color correction"
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
              description="Amount of floating particles in the scene"
            />
          </div>

          <div className="border-t border-cyan-500/10" />

          {/* Sky Theme */}
          <div>
            <SectionHeader title="SKY THEME" subtitle="Change the world atmosphere" />
            <div className="grid grid-cols-2 gap-1.5">
              {[
                { key: 'cyberpunk', label: 'CYBERPUNK', desc: 'Dark neon-lit night city' },
                { key: 'dreamworld', label: 'DREAMWORLD', desc: 'Bright open-world sky with clouds' },
              ].map(theme => (
                <button
                  key={theme.key}
                  onClick={() => updateSetting('skyTheme', theme.key)}
                  title={theme.desc}
                  className={`font-pixel text-[9px] py-2 rounded border transition-all tracking-wide ${
                    settings.skyTheme === theme.key
                      ? 'bg-cyan-500/20 border-cyan-500/50 text-cyan-400 shadow-[0_0_8px_rgba(6,182,212,0.2)]'
                      : 'bg-gray-800/40 border-gray-700/40 text-gray-500 hover:border-gray-600 hover:text-gray-400'
                  }`}
                >
                  {theme.label}
                </button>
              ))}
            </div>
          </div>

          <div className="border-t border-cyan-500/10" />

          {/* Scene Lighting */}
          <div>
            <SectionHeader title="SCENE LIGHTING" subtitle="Brightness and time of day" />
            <SettingSlider
              label="EXPOSURE"
              value={settings.sceneExposure ?? 1.0}
              onChange={(v) => updateSetting('sceneExposure', v)}
              min={0.5}
              max={2.5}
              step={0.1}
              format={(v) => `${v.toFixed(1)}x`}
              description="Post-bloom exposure adjustment — darkens or brightens assets without adding bloom"
            />
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
            <div className="py-1.5">
              <div className="font-pixel text-[10px] text-gray-400 tracking-wide mb-2">TIME OF DAY</div>
              <div className="grid grid-cols-4 gap-1.5">
                {['sunrise', 'noon', 'sunset', 'midnight'].map(tod => (
                  <button
                    key={tod}
                    onClick={() => updateSetting('timeOfDay', tod)}
                    className={`font-pixel text-[9px] py-2 rounded border transition-all tracking-wide ${
                      settings.timeOfDay === tod
                        ? 'bg-cyan-500/20 border-cyan-500/50 text-cyan-400 shadow-[0_0_8px_rgba(6,182,212,0.2)]'
                        : 'bg-gray-800/40 border-gray-700/40 text-gray-500 hover:border-gray-600 hover:text-gray-400'
                    }`}
                  >
                    {tod.toUpperCase()}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="border-t border-cyan-500/10" />

          {/* Reset */}
          <button
            onClick={resetSettings}
            className="w-full font-pixel text-[10px] py-2 rounded border border-red-500/30 text-red-400/60 hover:bg-red-500/10 hover:text-red-400 transition-all tracking-wider"
          >
            RESET DEFAULTS
          </button>
        </div>
      </div>
    </div>
  );
}
