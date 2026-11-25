import { formatCount } from '../../utils/formatters';

// The new-variable row's state is owned by ProviderForm: the drawer remounts
// this panel on every tab switch, so state held here would be lost.
export default function ProviderEnvironmentTab({
  formData, setFormData, onEditHarnessContext, managedContext, newEnvKey, setNewEnvKey, newEnvValue, setNewEnvValue, newEnvSecret, setNewEnvSecret,
}) {
  const rows = Object.entries(formData.envVars).filter(([key]) => key !== managedContext?.key);
  const reservedKey = managedContext && newEnvKey.trim() === managedContext.key;
  return (
    <div className="space-y-4">
      {onEditHarnessContext && (
        <button type="button" onClick={onEditHarnessContext}
          className="min-h-[36px] rounded border border-port-border px-3 text-sm text-port-accent hover:bg-port-border">
          Edit context in Generation
        </button>
      )}
      {managedContext && (
        <p className="text-xs text-gray-400">
          <code>{managedContext.key}</code> is set at launch from Generation{managedContext.followsRuntime ? ' and follows Splash' : ''}.
          {' '}Current preview: {formatCount(managedContext.tokens)} tokens.
        </p>
      )}
      {/* Consumed only when spawning CLI/TUI child processes; API runs
          never read them (auth is the API Key field on the Connection
          tab). For API type the add-row is hidden so a key can't be
          "set" here by mistake, but existing entries stay
          editable/removable. */}
      <div>
        {formData.type === 'api' && rows.length > 0 && (
          <p className="text-xs text-port-warning mb-2">
            API providers ignore environment variables — these entries have no effect.
            Put the key in the API Key field on the Connection tab.
          </p>
        )}
        {rows.length > 0 && (
          <div className="space-y-2 mb-3">
            {rows.map(([key, value]) => {
              const isSecret = formData.secretEnvVars.includes(key);
              return (
                <div key={key} className="flex items-center gap-2">
                  <code className="text-xs text-gray-300 bg-port-bg px-2 py-1.5 rounded border border-port-border shrink-0">{key}</code>
                  <input
                    type={isSecret ? 'password' : 'text'}
                    aria-label={`${key} value`}
                    value={value}
                    onChange={(e) => setFormData(prev => ({
                      ...prev,
                      envVars: { ...prev.envVars, [key]: e.target.value }
                    }))}
                    className="flex-1 min-w-0 px-2 py-1.5 bg-port-bg border border-port-border rounded text-white text-sm focus:border-port-accent focus:outline-hidden"
                  />
                  <button
                    type="button"
                    onClick={() => setFormData(prev => ({
                      ...prev,
                      secretEnvVars: isSecret
                        ? prev.secretEnvVars.filter(k => k !== key)
                        : [...prev.secretEnvVars, key]
                    }))}
                    className={`px-2 py-1.5 text-xs rounded transition-colors shrink-0 ${
                      isSecret
                        ? 'text-port-warning bg-port-warning/20 hover:bg-port-warning/30'
                        : 'text-gray-400 hover:bg-port-border/50'
                    }`}
                    title={isSecret ? 'Secret (click to unmask)' : 'Not secret (click to mask)'}
                  >
                    {isSecret ? '🔒' : '🔓'}
                  </button>
                  <button
                    type="button"
                    onClick={() => setFormData(prev => {
                      const { [key]: _, ...rest } = prev.envVars;
                      return {
                        ...prev,
                        envVars: rest,
                        secretEnvVars: prev.secretEnvVars.filter(k => k !== key)
                      };
                    })}
                    className="px-2 py-1.5 text-xs text-port-error hover:bg-port-error/20 rounded transition-colors shrink-0"
                  >
                    Remove
                  </button>
                </div>
              );
            })}
          </div>
        )}
        {formData.type !== 'api' && (
        <div className="flex gap-2">
          <input
            type="text"
            value={newEnvKey}
            onChange={(e) => setNewEnvKey(e.target.value.toUpperCase())}
            placeholder="KEY"
            aria-label="New environment variable name"
            className="w-1/3 px-2 py-1.5 bg-port-bg border border-port-border rounded text-white text-sm focus:border-port-accent focus:outline-hidden font-mono"
          />
          <input
            type={newEnvSecret ? 'password' : 'text'}
            value={newEnvValue}
            onChange={(e) => setNewEnvValue(e.target.value)}
            placeholder="value"
            aria-label="New environment variable value"
            className="flex-1 px-2 py-1.5 bg-port-bg border border-port-border rounded text-white text-sm focus:border-port-accent focus:outline-hidden"
          />
          <label className="flex items-center gap-1 text-xs text-gray-400 shrink-0 cursor-pointer" title="Mark as secret (value will be masked on provider list)">
            <input
              type="checkbox"
              checked={newEnvSecret}
              onChange={(e) => setNewEnvSecret(e.target.checked)}
              className="w-3.5 h-3.5 rounded border-port-border bg-port-bg"
            />
            Secret
          </label>
          <button
            type="button"
            onClick={() => {
              if (newEnvKey.trim() && !reservedKey) {
                setFormData(prev => ({
                  ...prev,
                  envVars: { ...prev.envVars, [newEnvKey.trim()]: newEnvValue },
                  secretEnvVars: newEnvSecret
                    ? [...prev.secretEnvVars, newEnvKey.trim()]
                    : prev.secretEnvVars
                }));
                setNewEnvKey('');
                setNewEnvValue('');
                setNewEnvSecret(false);
              }
            }}
            disabled={!newEnvKey.trim() || reservedKey}
            className="px-3 py-1.5 text-sm bg-port-border hover:bg-port-border/80 text-white rounded transition-colors disabled:opacity-50 shrink-0"
          >
            Add
          </button>
        </div>
        )}
        {reservedKey && <p className="text-xs text-port-warning mt-2">Change this setting in Generation.</p>}
        <p className="text-xs text-gray-500 mt-2">
          {formData.type === 'api'
            ? 'Not used by API providers — auth goes in the API Key field on the Connection tab. Env vars only apply to CLI/TUI process providers.'
            : 'Environment variables passed to the CLI process (e.g., CLAUDE_CODE_USE_BEDROCK=1, AWS_PROFILE).'}
        </p>
      </div>
    </div>
  );
}
