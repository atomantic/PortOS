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

function SettingToggle({ label, value, onChange }) {
  return (
    <div className="flex items-center justify-between py-1">
      <span className="font-pixel text-[10px] text-gray-400 tracking-wide">{label}</span>
      <button
        onClick={() => onChange(!value)}
        className={`w-8 h-4 rounded-full relative transition-colors ${value ? 'bg-cyan-500/40 border-cyan-500/60' : 'bg-gray-700/40 border-gray-600/40'} border`}
      >
        <div
          className={`absolute top-0.5 w-2.5 h-2.5 rounded-full transition-all ${value ? 'left-[14px] bg-cyan-400 shadow-[0_0_6px_rgba(6,182,212,0.5)]' : 'left-[2px] bg-gray-500'}`}
        />
      </button>
    </div>
  );
}

function SettingSlider({ label, value, onChange, min = 0, max = 1, step = 0.05, format }) {
  const displayValue = format
    ? format(value)
    : `${Math.round(value * 100)}%`;
  return (
    <div className="py-1">
      <div className="flex items-center justify-between mb-1">
        <span className="font-pixel text-[10px] text-gray-400 tracking-wide">{label}</span>
        <span className="font-pixel text-[9px] text-cyan-400/60">{displayValue}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="w-full h-1 bg-gray-700 rounded-full appearance-none cursor-pointer accent-cyan-500"
        style={{
          background: `linear-gradient(to right, #06b6d4 0%, #06b6d4 ${value / max * 100}%, #374151 ${value / max * 100}%, #374151 100%)`,
        }}
      />
    </div>
  );
}

export default function CitySettingsPanel() {
  const navigate = useNavigate();
  const { settings, updateSetting, resetSettings } = useCitySettingsContext();

  if (!settings) return null;

  return (
    <div className="absolute bottom-4 right-4 z-50 pointer-events-auto animate-in slide-in-from-bottom-4 duration-300">
      <div className="relative bg-black/90 backdrop-blur-md border border-cyan-500/30 rounded-lg w-72 max-h-[80vh] overflow-y-auto">
        <HudCorner position="tl" />
        <HudCorner position="tr" />
        <HudCorner position="bl" />
        <HudCorner position="br" />

        {/* Header */}
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-cyan-500/20">
          <span className="font-pixel text-[11px] text-cyan-400 tracking-widest" style={{ textShadow: '0 0 8px rgba(6,182,212,0.4)' }}>
            SETTINGS
          </span>
          <button
            onClick={() => navigate('/city')}
            className="font-pixel text-[10px] text-gray-500 hover:text-cyan-400 transition-colors tracking-wide"
          >
            [X]
          </button>
        </div>

        <div className="px-4 py-3 space-y-4">
          {/* Quality Preset */}
          <div>
            <div className="font-pixel text-[9px] text-cyan-500/60 tracking-wider mb-2">QUALITY PRESET</div>
            <div className="grid grid-cols-4 gap-1">
              {Object.keys(QUALITY_PRESETS).map(preset => (
                <button
                  key={preset}
                  onClick={() => updateSetting('qualityPreset', preset)}
                  className={`font-pixel text-[9px] py-1.5 rounded border transition-all tracking-wide ${
                    settings.qualityPreset === preset
                      ? 'bg-cyan-500/20 border-cyan-500/50 text-cyan-400 shadow-[0_0_8px_rgba(6,182,212,0.2)]'
                      : 'bg-gray-800/40 border-gray-700/40 text-gray-500 hover:border-gray-600'
                  }`}
                >
                  {preset.toUpperCase()}
                </button>
              ))}
            </div>
          </div>

          {/* Music */}
          <div>
            <div className="font-pixel text-[9px] text-cyan-500/60 tracking-wider mb-1">MUSIC</div>
            <SettingToggle
              label="SYNTHWAVE"
              value={settings.musicEnabled}
              onChange={(v) => updateSetting('musicEnabled', v)}
            />
            {settings.musicEnabled && (
              <SettingSlider
                label="VOLUME"
                value={settings.musicVolume}
                onChange={(v) => updateSetting('musicVolume', v)}
              />
            )}
          </div>

          {/* Sound Effects */}
          <div>
            <div className="font-pixel text-[9px] text-cyan-500/60 tracking-wider mb-1">SOUND FX</div>
            <SettingToggle
              label="ENABLED"
              value={settings.sfxEnabled}
              onChange={(v) => updateSetting('sfxEnabled', v)}
            />
            {settings.sfxEnabled && (
              <SettingSlider
                label="VOLUME"
                value={settings.sfxVolume}
                onChange={(v) => updateSetting('sfxVolume', v)}
              />
            )}
          </div>

          {/* Visual Effects */}
          <div>
            <div className="font-pixel text-[9px] text-cyan-500/60 tracking-wider mb-1">VISUAL FX</div>
            <SettingToggle
              label="BLOOM"
              value={settings.bloomEnabled}
              onChange={(v) => updateSetting('bloomEnabled', v)}
            />
            {settings.bloomEnabled && (
              <SettingSlider
                label="STRENGTH"
                value={settings.bloomStrength}
                onChange={(v) => updateSetting('bloomStrength', v)}
              />
            )}
            <SettingToggle
              label="REFLECTIONS"
              value={settings.reflectionsEnabled}
              onChange={(v) => updateSetting('reflectionsEnabled', v)}
            />
            <SettingToggle
              label="CHROMATIC ABERRATION"
              value={settings.chromaticAberration}
              onChange={(v) => updateSetting('chromaticAberration', v)}
            />
            <SettingToggle
              label="FILM GRAIN"
              value={settings.filmGrain}
              onChange={(v) => updateSetting('filmGrain', v)}
            />
            <SettingToggle
              label="COLOR GRADING"
              value={settings.colorGrading}
              onChange={(v) => updateSetting('colorGrading', v)}
            />
            <SettingToggle
              label="SCANLINES"
              value={settings.scanlineOverlay}
              onChange={(v) => updateSetting('scanlineOverlay', v)}
            />
            <SettingSlider
              label="PARTICLE DENSITY"
              value={settings.particleDensity}
              onChange={(v) => updateSetting('particleDensity', v)}
              min={0.25}
              max={2}
              step={0.25}
            />
          </div>

          {/* Scene Lighting */}
          <div>
            <div className="font-pixel text-[9px] text-cyan-500/60 tracking-wider mb-1">SCENE LIGHTING</div>
            <SettingSlider
              label="AMBIENT BRIGHTNESS"
              value={settings.ambientBrightness}
              onChange={(v) => updateSetting('ambientBrightness', v)}
              min={0.5}
              max={2.5}
              step={0.1}
              format={(v) => `${v.toFixed(1)}x`}
            />
            <SettingSlider
              label="NEON BRIGHTNESS"
              value={settings.neonBrightness}
              onChange={(v) => updateSetting('neonBrightness', v)}
              min={0.5}
              max={2.5}
              step={0.1}
              format={(v) => `${v.toFixed(1)}x`}
            />
            <SettingSlider
              label="FOG"
              value={settings.fogDensity}
              onChange={(v) => updateSetting('fogDensity', v)}
              min={0}
              max={0.03}
              step={0.001}
              format={(v) => v === 0 ? 'OFF' : v.toFixed(3)}
            />
          </div>

          {/* Reset */}
          <button
            onClick={resetSettings}
            className="w-full font-pixel text-[9px] py-1.5 rounded border border-red-500/30 text-red-400/60 hover:bg-red-500/10 hover:text-red-400 transition-all tracking-wider"
          >
            RESET DEFAULTS
          </button>
        </div>
      </div>
    </div>
  );
}
