import { useState, useEffect } from 'react';
import { Zap } from 'lucide-react';
import { nanoAvailability } from '../../../services/browserLlm';
import FormField from '../../ui/FormField';

// On-device (Gemini Nano) availability → [label, text tone, dot tone].
const NANO_STATUS_UI = {
  available: ['On-device model ready', 'text-port-success', 'bg-port-success'],
  downloadable: ['Available — downloads on first use', 'text-port-warning', 'bg-port-warning'],
  downloading: ['Downloading…', 'text-port-warning', 'bg-port-warning'],
  unavailable: ['Not available on this device', 'text-gray-500', 'bg-gray-500'],
  'no-api': ['Chrome built-in AI not detected', 'text-gray-500', 'bg-gray-500'],
};

export default function VoiceFastPathSection({ fastPathCfg, sttEngine, patch, inputCls }) {
  // On-device (Gemini Nano) availability for the fast-resolution tier-2 pill.
  const [nanoStatus, setNanoStatus] = useState(null);

  // Probe on-device (Gemini Nano) availability for the fast-resolution pill.
  // Re-checks when the browser-LLM tier is toggled on — the user may have just
  // enabled the Chrome flag and come back to this tab.
  const fastBrowserLlm = fastPathCfg?.browserLlm;
  useEffect(() => {
    let live = true;
    nanoAvailability()
      .then((s) => { if (live) setNanoStatus(s); })
      .catch(() => { if (live) setNanoStatus('unavailable'); });
    return () => { live = false; };
  }, [fastBrowserLlm]);

  if (!fastPathCfg) return null;

  const nanoUi = NANO_STATUS_UI[nanoStatus] || ['Checking…', 'text-gray-500', 'bg-gray-500'];

  return (
    /* Fast-resolution cascade — lower spoken-turn latency by triaging most
       turns before the (slow) server LLM. */
    <div className="md:col-span-2 border-t border-port-border/50 pt-4 space-y-3">
      <div className="flex items-center gap-2 text-white">
        <Zap size={15} className="text-port-accent" />
        <span className="text-sm font-medium">Fast resolution (lower latency)</span>
      </div>
      <p className="text-xs text-gray-500 -mt-1">
        Triage each turn through fast tiers before the server LLM: instant trigger commands →
        on-device browser model (Gemini Nano) → your server provider above. Common turns
        ("go to tasks", quick questions) skip the slow model entirely. Uses browser speech
        recognition, so set the STT engine to Web Speech.
      </p>

      <label className="flex items-start gap-3 cursor-pointer">
        <input
          type="checkbox"
          checked={fastPathCfg.enabled === true}
          onChange={(e) => patch('llm.fastPath.enabled', e.target.checked)}
          className="w-4 h-4 mt-0.5 shrink-0"
        />
        <div className="flex flex-col sm:flex-row sm:flex-wrap sm:items-baseline gap-x-3 gap-y-0.5 min-w-0 flex-1">
          <span className="text-sm text-white">Enable fast-resolution cascade</span>
          <span className="text-xs text-gray-500">Off by default — turns run entirely on the server LLM.</span>
        </div>
      </label>

      {fastPathCfg.enabled === true && (
        <div className="pl-7 space-y-3">
          {sttEngine !== 'web-speech' && (
            <p className="text-xs text-port-warning">
              Fast resolution needs browser speech recognition. Set the STT engine to
              “Web Speech API” above, or spoken turns fall back to the server.
            </p>
          )}

          <label className="flex items-start gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={fastPathCfg.triggers !== false}
              onChange={(e) => patch('llm.fastPath.triggers', e.target.checked)}
              className="w-4 h-4 mt-0.5 shrink-0"
            />
            <div className="flex flex-col sm:flex-row sm:flex-wrap sm:items-baseline gap-x-3 gap-y-0.5 min-w-0 flex-1">
              <span className="text-sm text-white">Tier 1 — trigger commands (instant, offline)</span>
              <span className="text-xs text-gray-500">"go to tasks", "open daily log" navigate immediately — no LLM.</span>
            </div>
          </label>

          <label className="flex items-start gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={fastPathCfg.browserLlm !== false}
              onChange={(e) => patch('llm.fastPath.browserLlm', e.target.checked)}
              className="w-4 h-4 mt-0.5 shrink-0"
            />
            <div className="flex flex-col sm:flex-row sm:flex-wrap sm:items-baseline gap-x-3 gap-y-0.5 min-w-0 flex-1">
              <span className="text-sm text-white">Tier 2 — on-device browser model (Gemini Nano)</span>
              <span className="text-xs text-gray-500">Answers simple/conversational turns in the browser; escalates actions to the server.</span>
            </div>
          </label>

          {fastPathCfg.browserLlm !== false && (
            <div className="pl-7 space-y-2">
              <div className="flex items-center gap-2">
                <span className={`w-2 h-2 rounded-full ${nanoUi[2]}`} />
                <span className={`text-xs ${nanoUi[1]}`}>{nanoUi[0]}</span>
              </div>
              {(nanoStatus === 'no-api' || nanoStatus === 'unavailable') && (
                <p className="text-xs text-gray-500">
                  Requires Chrome/Edge with the on-device model. Enable
                  <code className="mx-1 text-gray-400">chrome://flags/#prompt-api-for-gemini-nano</code>
                  and
                  <code className="mx-1 text-gray-400">chrome://flags/#optimization-guide-on-device-model</code>,
                  then restart the browser. Turns fall back to the server model when unavailable.
                </p>
              )}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <FormField label="Temperature" hint="0 = deterministic, higher = more varied. Default 0.7.">
                  <input
                    type="number"
                    min="0"
                    max="2"
                    step="0.1"
                    value={fastPathCfg.browser?.temperature ?? 0.7}
                    onChange={(e) => {
                      const v = parseFloat(e.target.value);
                      patch('llm.fastPath.browser.temperature', Number.isFinite(v) ? Math.min(2, Math.max(0, v)) : 0.7);
                    }}
                    className={inputCls}
                  />
                </FormField>
                <FormField label="Top-K" hint="Sampling breadth. Default 3.">
                  <input
                    type="number"
                    min="1"
                    max="128"
                    step="1"
                    value={fastPathCfg.browser?.topK ?? 3}
                    onChange={(e) => {
                      const v = parseInt(e.target.value, 10);
                      patch('llm.fastPath.browser.topK', Number.isFinite(v) ? Math.min(128, Math.max(1, v)) : 3);
                    }}
                    className={inputCls}
                  />
                </FormField>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
