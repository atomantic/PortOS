/** Small presentational sections of MusicGenPanel (no state of their own). */

import { Loader2, Download } from 'lucide-react';
import { formatExecutionProfile } from './musicEngineModels.js';
import { instrumentalHint } from './musicGenLabels.js';

export const REMOTE_AUDIO_OPTIONS = Object.freeze({
  style: ['ambient', 'cinematic', 'classical', 'electronic', 'folk', 'hip-hop', 'jazz', 'metal', 'orchestral', 'pop', 'rock', 'synthwave'],
  mood: ['bright', 'calm', 'dark', 'dreamy', 'energetic', 'hopeful', 'melancholic', 'mysterious', 'playful', 'tense', 'triumphant', 'warm'],
  tempo: ['slow', 'moderate', 'fast'],
  energy: ['low', 'medium', 'high'],
});

export const DEFAULT_REMOTE_PROFILE = Object.freeze({
  style: 'ambient',
  mood: 'calm',
  tempo: 'moderate',
  energy: 'medium',
  instruments: [],
});

const formatRemoteOption = (value) => value.replaceAll('-', ' ');

// Audio's fixed-vocabulary conditioning profile — the only musical direction
// allowed across the peer boundary (ADR docs/decisions/2026-08-20-federated-visual-prompts.md).
// Rendered as RemoteMediaTargetPicker children so the shared component knows
// nothing about audio.
export function RemoteProfileFields({ remoteProfile, setRemoteProfile, remoteLyricsAvailable }) {
  return (
    <>
      <div className="grid grid-cols-2 gap-2">
        {(['style', 'mood', 'tempo', 'energy']).map((field) => (
          <label key={field} className="block">
            <span className="block text-[11px] uppercase tracking-wider text-gray-500 mb-1">{field}</span>
            <select
              aria-label={`Remote ${field}`}
              value={remoteProfile[field]}
              onChange={(e) => setRemoteProfile((current) => ({ ...current, [field]: e.target.value }))}
              className="w-full px-2 py-1.5 bg-port-bg border border-port-border rounded text-white text-sm"
            >
              {REMOTE_AUDIO_OPTIONS[field].map((option) => <option key={option} value={option}>{formatRemoteOption(option)}</option>)}
            </select>
          </label>
        ))}
      </div>
      <p className="text-[10px] text-gray-500">
        {remoteLyricsAvailable
          ? 'This fixed musical profile crosses the peer boundary in place of your prompt, which stays on this instance. Lyrics are sent as written — they are the words the model sings.'
          : 'Only this fixed musical profile crosses the peer boundary; your prompt and lyrics remain on this instance.'}
      </p>
    </>
  );
}

export function SetupBanner({ setup, installing, onInstall }) {
  return (
    <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 rounded-lg border border-port-warning/30 bg-port-warning/10 px-3 py-2">
      <p className="text-[11px] text-port-warning">
        {setup.message}
      </p>
      {setup.label ? <button
        type="button"
        onClick={onInstall}
        disabled={installing}
        className="inline-flex items-center justify-center gap-2 whitespace-nowrap px-3 py-1.5 rounded-lg bg-port-bg border border-port-warning/50 text-port-warning text-xs font-medium hover:border-port-warning disabled:opacity-50"
      >
        {installing ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />}
        {setup.label}
      </button>
      : null}
    </div>
  );
}

export function InstrumentalToggle({ checked, onChange, disabled, hintArgs }) {
  return (
    <div className="rounded-lg border border-port-border bg-port-bg px-3 py-2">
      <div className="flex items-center gap-2">
        <input
          id="musicgen-instrumental-only"
          type="checkbox"
          checked={checked}
          onChange={(event) => onChange(event.target.checked)}
          disabled={disabled}
          aria-describedby="musicgen-instrumental-only-hint"
          className="h-4 w-4 accent-port-accent"
        />
        <label htmlFor="musicgen-instrumental-only" className="text-sm font-medium text-gray-300">
          Instrumental only
        </label>
      </div>
      <p id="musicgen-instrumental-only-hint" className="mt-1 text-[11px] text-gray-500">
        {instrumentalHint(hintArgs)}
      </p>
    </div>
  );
}

// Install an additional model from HuggingFace — only for engines that can
// render an arbitrary checkpoint (musicgen/audioldm2). ACE-Step uses a fixed
// foundation checkpoint, so the caller hides this for it.
export function ModelInstallForm({ installRepo, setInstallRepo, installing, installProgress, onInstall }) {
  return (
    <div className="pt-2 border-t border-port-border/60">
      <label htmlFor="musicgen-install-repo" className="block text-[11px] uppercase tracking-wider text-gray-500 mb-1">Install a model from HuggingFace</label>
      <div className="flex items-center gap-2">
        <input
          id="musicgen-install-repo"
          value={installRepo}
          onChange={(e) => setInstallRepo(e.target.value)}
          placeholder="org/model-repo"
          disabled={installing}
          className="flex-1 px-2 py-1.5 bg-port-bg border border-port-border rounded text-white text-sm disabled:opacity-50"
        />
        <button
          type="button"
          onClick={onInstall}
          disabled={installing || !installRepo.trim()}
          className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg bg-port-bg border border-port-border text-white text-sm hover:border-port-accent disabled:opacity-50"
        >
          {installing ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
          Install
        </button>
      </div>
      {installProgress ? <p className="text-[11px] text-gray-500 mt-1 truncate">{installProgress.message}</p> : null}
    </div>
  );
}

export function ExecutionProfileNote({ activeProfile, engine }) {
  if (activeProfile) {
    return (
      <p className="text-[11px] text-gray-400">
        Active render profile: <span className="text-gray-300">{formatExecutionProfile(activeProfile)}</span>
      </p>
    );
  }
  if (!engine?.executionProfile) return null;
  return (
    <p className="text-[11px] text-gray-500">
      Execution profile: {engine.vramProfileLabel || formatExecutionProfile(engine.executionProfile)}
    </p>
  );
}
