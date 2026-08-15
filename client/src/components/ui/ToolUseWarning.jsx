import { AlertTriangle } from 'lucide-react';

/**
 * The "this model can't call tools" warning every agent picker shows below its
 * model control. Three editors of the same class of pin used to word it three
 * different ways (ProviderModelSelector, the Creative Director Models drawer,
 * and — until now — nothing at all in AI Assignments), so the advice lives here
 * once.
 *
 * Deliberately phrased as UNVERIFIED, not a proven negative: the capability
 * signal behind it is a positive allowlist unioned with what the backend
 * reports, so a tool-capable family neither knows yet lands here too. That is
 * also why this is a warning and never a filter — hiding those options would
 * make a newer tool-capable model unselectable.
 *
 * @param {object} props
 * @param {string} props.model - the EFFECTIVE model being warned about
 * @param {boolean} [props.isProviderDefault] - true when `model` came from the
 *   provider's `defaultModel` rather than an explicit pin, which is worth saying
 *   out loud: the control above reads "Default / auto" and looks unset.
 * @param {string} [props.className] - spacing for the host layout
 * @param {import('react').ReactNode} [props.children] - trailing remediation
 *   links; hosts outside a Router context must omit them.
 */
export default function ToolUseWarning({ model, isProviderDefault = false, className = '', children }) {
  return (
    <p className={`flex items-start gap-1.5 text-xs text-port-warning ${className}`}>
      <AlertTriangle size={13} className="shrink-0 mt-0.5" aria-hidden="true" />
      <span>
        <span className="font-medium">{model}</span>
        {isProviderDefault && ' (this provider’s default)'} isn&apos;t a recognized tool-calling
        model — many local models (e.g. Gemma) reply with text instead of calling tools, which can
        leave this agent stuck. Prefer a recognized tool-capable model (e.g.{' '}
        <span className="text-gray-300">qwen3.6:35b</span>) or an API/CLI provider.{children ? ' ' : ''}
        {children}
      </span>
    </p>
  );
}
