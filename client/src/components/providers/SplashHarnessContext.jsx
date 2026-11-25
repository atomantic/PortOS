import { useState } from 'react';
import { Link } from 'react-router';
import ContextWindowSelect from '../ui/ContextWindowSelect.jsx';
import { FormField } from '../ui/FormField';
import { formatCount } from '../../utils/formatters';
import { CONTEXT_CHOICES, parseHarnessContext } from './harnessContextForm.js';

const OPTIONS = [
  { value: '', label: 'Follow Splash runtime' },
  ...CONTEXT_CHOICES.map(([label, tokens]) => ({ value: String(tokens), label })),
  { value: 'custom', label: 'Custom size' },
];

export default function SplashHarnessContext({ target, value, onChange, servedWindow }) {
  const [custom, setCustom] = useState(false);
  const followsRuntime = value === '';
  const tokens = parseHarnessContext(value);
  const knownChoice = CONTEXT_CHOICES.some(([, count]) => count === tokens);
  const selected = followsRuntime ? '' : custom || !knownChoice ? 'custom' : String(tokens);
  const label = target.kind === 'claude' ? 'Claude Code context' : 'OpenCode context';
  const observed = Number.isSafeInteger(servedWindow);
  return (
    <div className="space-y-1.5">
      <FormField label={label}
        hint="Follow the running Splash size automatically, or set a separate limit for this preset.">
        <ContextWindowSelect label={label} value={selected} options={OPTIONS} onChange={(event) => {
          const next = event.target.value;
          setCustom(next === 'custom');
          onChange(next === 'custom' ? String(tokens ?? servedWindow ?? target.fallback) : next);
        }} />
      </FormField>
      {selected === 'custom' && (
        <FormField label="Custom context tokens" hint="Enter tokens or shorthand (K = 1,024; M = 1,000,000).">
          <input type="text" value={value ?? ''} onChange={(event) => onChange(event.target.value || null)}
            spellCheck={false} className="w-full rounded border border-port-border bg-port-bg px-3 py-2 text-sm text-white" />
        </FormField>
      )}
      <p className="text-xs text-gray-400">
        {observed ? `Splash is serving ${formatCount(servedWindow)} tokens.`
          : `The running limit is unknown. Follow mode falls back to ${formatCount(target.fallback)} tokens.`}
      </p>
      {tokens > servedWindow && servedWindow > 0 && (
        <p role="status" className="text-xs text-port-warning">This preset limit is above the server’s current window.</p>
      )}
      <Link to="/models/llms-runtimes/splash" target="_blank" rel="noreferrer"
        className="inline-flex min-h-[36px] items-center text-xs text-port-accent hover:underline">
        Open Splash runtime settings
      </Link>
    </div>
  );
}
