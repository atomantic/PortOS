import { FormField } from '../ui/FormField';
import { formatCount } from '../../utils/formatters';
import { CONTEXT_CHOICES, parseHarnessContext } from './harnessContextForm.js';

export default function ProviderHarnessContext({ target, value, onChange, onUseServed, servedWindow }) {
  const inherited = target.inherited ?? target.fallback;
  const parsed = parseHarnessContext(value) ?? inherited;
  return (
    <FormField label={target.kind === 'claude' ? 'Claude Code context' : 'OpenCode context'}
      hint={target.kind === 'claude'
        ? 'Used by Claude Code for custom model IDs. It does not raise the server’s limit.'
        : `Context limit OpenCode uses for ${target.model}. It does not raise the server’s limit.`}>
      <input
        type="text"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={inherited ? `${formatCount(inherited)} (inherited)` : 'Harness default'}
        spellCheck={false}
        className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white focus:border-port-accent focus:outline-hidden"
      />
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {CONTEXT_CHOICES.map(([label, tokens]) => (
          <button type="button" key={tokens} aria-pressed={tokens === parsed}
            className="min-h-[36px] rounded border border-port-border px-2.5 text-xs text-gray-300 hover:bg-port-border aria-pressed:border-port-accent aria-pressed:text-port-accent"
            onClick={() => onChange(label)}>{label}</button>
        ))}
        <button type="button" disabled={value === ''} onClick={() => onChange('')}
          className="min-h-[36px] rounded border border-port-border px-2.5 text-xs text-gray-300 hover:bg-port-border disabled:opacity-50">
          Use default
        </button>
      </div>
      <p className="text-xs mt-1 text-gray-500">Enter tokens or shorthand (K = 1,024; M = 1,000,000).</p>
      {Number.isSafeInteger(servedWindow) && (
        <div className="flex flex-wrap items-center gap-2 text-xs text-gray-400">
          <span>Server currently reports {formatCount(servedWindow)} tokens.</span>
          <button type="button" onClick={onUseServed}
            className="min-h-[36px] rounded border border-port-border px-2.5 text-port-accent hover:bg-port-border">
            Match server
          </button>
        </div>
      )}
      {parsed > servedWindow && servedWindow > 0 && (
        <p role="status" className="text-xs text-port-warning">
          This is above the server’s current window. Raise the server limit before using it.
        </p>
      )}
    </FormField>
  );
}
