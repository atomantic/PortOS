import { useState } from 'react';
import { ChevronDown, ChevronRight, Copy } from 'lucide-react';
import { copyToClipboard } from '../../lib/clipboard';

const TRUNCATE_LIMIT = 96;

/**
 * Safely tries to parse a string as JSON.
 * Returns parsed object/array or null if not valid JSON.
 */
function tryParseJson(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (
    (!trimmed.startsWith('{') || !trimmed.endsWith('}')) &&
    (!trimmed.startsWith('[') || !trimmed.endsWith(']'))
  ) {
    return null;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

/**
 * Renders a single env var key-value row with truncation,
 * JSON formatting, expand/collapse, and safe secret masking.
 */
function EnvVarRow({ name, value, isSecret, notSet }) {
  const [expanded, setExpanded] = useState(false);

  if (isSecret) {
    return (
      <div className="min-w-0 max-w-full">
        <code className="text-orange-400 break-all">
          {name}={notSet ? '(not set)' : '***'}
        </code>
      </div>
    );
  }

  const strValue = typeof value === 'string' ? value : String(value ?? '');
  const parsedJson = tryParseJson(strValue);
  const isJson = parsedJson !== null;
  const isLong = strValue.length > TRUNCATE_LIMIT || isJson;

  const handleCopy = (e) => {
    e.stopPropagation();
    copyToClipboard(strValue, `${name} copied`);
  };

  if (!isLong) {
    return (
      <div className="min-w-0 max-w-full">
        <code className="text-orange-400 break-all">
          {name}={strValue}
        </code>
      </div>
    );
  }

  // Preview for collapsed state:
  // If JSON, render a compact single-line preview; otherwise truncate plain text.
  let previewText = strValue;
  if (isJson) {
    try {
      previewText = JSON.stringify(parsedJson);
    } catch {
      previewText = strValue;
    }
  }
  const displayText = previewText.length > TRUNCATE_LIMIT
    ? `${previewText.slice(0, TRUNCATE_LIMIT)}…`
    : previewText;

  return (
    <div className="min-w-0 max-w-full">
      <div className="inline-flex flex-wrap items-baseline gap-1 max-w-full">
        <code className="text-orange-400 break-all min-w-0">
          {name}=
          {!expanded && (
            <span>{displayText}</span>
          )}
        </code>

        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          className="inline-flex items-center gap-0.5 text-[11px] text-gray-400 hover:text-gray-200 transition-colors py-0.5 px-1 rounded hover:bg-port-border/40 select-none cursor-pointer"
          aria-expanded={expanded}
          aria-label={expanded ? `Collapse ${name} value` : `Expand ${name} value`}
        >
          {expanded ? (
            <>
              <ChevronDown size={11} aria-hidden="true" className="shrink-0" />
              <span>collapse</span>
            </>
          ) : (
            <>
              <ChevronRight size={11} aria-hidden="true" className="shrink-0" />
              <span>expand</span>
            </>
          )}
        </button>

        {expanded && (
          <button
            type="button"
            onClick={handleCopy}
            title={`Copy ${name} value`}
            aria-label={`Copy ${name} value`}
            className="inline-flex items-center gap-1 text-[11px] text-gray-400 hover:text-gray-200 transition-colors py-0.5 px-1 rounded hover:bg-port-border/40 select-none cursor-pointer"
          >
            <Copy size={11} aria-hidden="true" className="shrink-0" />
            <span>copy</span>
          </button>
        )}
      </div>

      {expanded && (
        <div className="mt-1 max-w-full min-w-0 overflow-x-auto rounded bg-port-bg/80 border border-port-border/50 p-2">
          {isJson ? (
            <pre className="text-[11px] text-orange-300 font-mono whitespace-pre-wrap break-all min-w-0">
              {JSON.stringify(parsedJson, null, 2)}
            </pre>
          ) : (
            <pre className="text-[11px] text-orange-300 font-mono whitespace-pre-wrap break-all min-w-0">
              {strValue}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Shared renderer for provider environment variables.
 * Used on ProviderCard and AIProviders preset list.
 *
 * @param {Object} props
 * @param {Record<string, string>} props.envVars
 * @param {string[]} [props.secretEnvVars]
 * @param {string} [props.className]
 */
export default function ProviderEnvVars({ envVars, secretEnvVars = [], className = '' }) {
  if (!envVars || typeof envVars !== 'object') return null;
  const entries = Object.entries(envVars);
  if (entries.length === 0) return null;

  return (
    <div className={`text-xs min-w-0 max-w-full overflow-hidden ${className}`.trim()}>
      <span className="text-gray-400 font-normal">Env:</span>
      <div className="mt-0.5 space-y-1 min-w-0 max-w-full">
        {entries.map(([k, v]) => {
          const isSecret = secretEnvVars?.includes(k);
          const notSet = isSecret && v === '';
          return (
            <EnvVarRow
              key={k}
              name={k}
              value={v}
              isSecret={isSecret}
              notSet={notSet}
            />
          );
        })}
      </div>
    </div>
  );
}
