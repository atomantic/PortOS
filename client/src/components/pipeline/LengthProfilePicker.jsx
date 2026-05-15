/**
 * Inline length-profile picker for the issue page header. Shows a compact
 * chip with the current preset + page/minute summary. Clicking opens a
 * dropdown with the four presets and a Custom option. Selecting Custom
 * expands two number inputs (pages, minutes) inline in the dropdown.
 *
 * The schema (`issue.lengthProfile`, `issue.pageTarget`, `issue.minutesTarget`)
 * is persisted by the server's issue sanitizer; this component just emits the
 * patch shape via `onChange`.
 */

import { useEffect, useRef, useState } from 'react';
import { ChevronDown, Gauge } from 'lucide-react';
import { LENGTH_PROFILES, summarizeLengthProfile, clampInt, CUSTOM_PAGE_MIN, CUSTOM_PAGE_MAX, CUSTOM_MINUTE_MIN, CUSTOM_MINUTE_MAX } from '../../lib/issueLength';

const PRESET_ORDER = ['teaser', 'standard', 'extended', 'finale'];

export default function LengthProfilePicker({ issue, onChange, disabled = false }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);
  const profile = issue?.lengthProfile || 'standard';
  const summary = summarizeLengthProfile(issue);

  // Auto-close the menu if the parent disables us mid-interaction. Prevents
  // a stranded open menu over a disabled trigger during auto-run kickoff.
  useEffect(() => {
    if (disabled && open) setOpen(false);
  }, [disabled, open]);

  // Close on outside click or Escape.
  useEffect(() => {
    if (!open) return undefined;
    const onDoc = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const choose = (next) => {
    // For presets we send just `lengthProfile`; pageTarget / minutesTarget
    // stay at whatever the issue had (or null) so toggling back to Custom
    // remembers the user's last manual values.
    onChange?.({ lengthProfile: next });
    setOpen(false);
  };

  // Custom mode: edit pages + minutes inline. Defaults reflect the saved
  // values, falling back to the standard preset so the inputs aren't blank
  // the first time the user clicks Custom.
  const std = LENGTH_PROFILES.standard;
  const [customPages, setCustomPages] = useState(
    issue?.pageTarget ?? std.pageTarget,
  );
  const [customMinutes, setCustomMinutes] = useState(
    issue?.minutesTarget ?? std.minutesTarget,
  );
  useEffect(() => {
    setCustomPages(issue?.pageTarget ?? std.pageTarget);
    setCustomMinutes(issue?.minutesTarget ?? std.minutesTarget);
  }, [issue?.pageTarget, issue?.minutesTarget, std.pageTarget, std.minutesTarget]);

  const clampedPages = clampInt(customPages, CUSTOM_PAGE_MIN, CUSTOM_PAGE_MAX);
  const clampedMinutes = clampInt(customMinutes, CUSTOM_MINUTE_MIN, CUSTOM_MINUTE_MAX);
  const applyDisabled = clampedPages === null || clampedMinutes === null;

  const saveCustom = () => {
    onChange?.({
      lengthProfile: 'custom',
      pageTarget: clampedPages,
      minutesTarget: clampedMinutes,
    });
    setOpen(false);
  };

  return (
    <div ref={wrapRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={disabled}
        className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-port-card border border-port-border text-xs text-gray-300 hover:text-white hover:border-port-accent/50 disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:text-gray-300 disabled:hover:border-port-border"
        title={disabled
          ? 'Length profile is locked while auto-run is active'
          : 'Episode length profile — drives beat / prose / script size targets'}
        aria-expanded={open}
        aria-disabled={disabled}
        aria-label={`Length profile: ${summary.label} (${summary.detail})`}
      >
        <Gauge size={12} className="text-gray-500" />
        <span className="font-medium text-white">{summary.label}</span>
        <span className="text-gray-500">· {summary.detail}</span>
        <ChevronDown size={12} className="text-gray-500" />
      </button>

      {open && (
        <div className="absolute right-0 mt-1 w-72 bg-port-card border border-port-border rounded-lg shadow-lg z-30 p-1">
          {PRESET_ORDER.map((id) => {
            const preset = LENGTH_PROFILES[id];
            const active = profile === id;
            return (
              <button
                key={id}
                type="button"
                onClick={() => choose(id)}
                className={`w-full text-left px-2 py-1.5 rounded text-xs ${
                  active ? 'bg-port-accent/15 text-white' : 'text-gray-300 hover:bg-port-bg hover:text-white'
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium">{preset.label}</span>
                  <span className="text-[10px] text-gray-500">{preset.pageTarget}pg / {preset.minutesTarget}min</span>
                </div>
                <div className="text-[10px] text-gray-500 mt-0.5">{preset.description}</div>
              </button>
            );
          })}

          <div className={`mt-1 pt-1 border-t border-port-border ${profile === 'custom' ? 'bg-port-accent/5 rounded' : ''}`}>
            <div className="px-2 py-1.5">
              <div className="flex items-center justify-between gap-2 mb-1">
                <span className="text-xs font-medium text-white">Custom</span>
                <span className="text-[10px] text-gray-500">free-form pages + minutes</span>
              </div>
              <div className="flex items-center gap-2">
                <label className="flex-1 text-[10px] text-gray-500">
                  Pages
                  <input
                    type="number"
                    min={CUSTOM_PAGE_MIN}
                    max={CUSTOM_PAGE_MAX}
                    value={customPages}
                    onChange={(e) => setCustomPages(e.target.value)}
                    className="block w-full mt-0.5 px-2 py-1 bg-port-bg border border-port-border rounded text-white text-xs"
                  />
                </label>
                <label className="flex-1 text-[10px] text-gray-500">
                  Minutes
                  <input
                    type="number"
                    min={CUSTOM_MINUTE_MIN}
                    max={CUSTOM_MINUTE_MAX}
                    value={customMinutes}
                    onChange={(e) => setCustomMinutes(e.target.value)}
                    className="block w-full mt-0.5 px-2 py-1 bg-port-bg border border-port-border rounded text-white text-xs"
                  />
                </label>
              </div>
              <button
                type="button"
                onClick={saveCustom}
                disabled={applyDisabled}
                title={applyDisabled ? 'Enter a page count and minute count to apply' : 'Save custom length profile'}
                className="mt-2 w-full px-2 py-1 rounded bg-port-accent text-white text-xs font-medium hover:bg-port-accent/90 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-port-accent"
              >
                Apply custom length
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
