import { useEffect, useState } from 'react';
import { getSettings, updateSettings } from '../../services/api';
import useProviderModels from '../../hooks/useProviderModels';
import ProviderModelSelector from '../ProviderModelSelector';
import toast from '../ui/Toast';

const SOURCES = [
  ['defaults', 'Shared defaults'], ['github-issue', 'GitHub issues'], ['github-pr', 'GitHub pull requests'],
  ['messages', 'Messages'], ['email', 'Email'], ['imessage', 'iMessage'], ['signal', 'Signal'],
];
const PRIVATE_SOURCES = ['messages', 'email', 'imessage', 'signal'];
const apiProvider = provider => provider.type === 'api';
const localApiProvider = provider => {
  if (!apiProvider(provider) || !URL.canParse(provider.endpoint)) return false;
  const endpoint = new URL(provider.endpoint);
  return ['http:', 'https:'].includes(endpoint.protocol) && !endpoint.username && !endpoint.password
    && ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname.toLowerCase());
};
const INPUT_CLASS = 'w-full min-w-0 px-3 py-2 bg-port-bg border border-port-border rounded-lg text-sm text-white';

export default function UntrustedContentPolicyPanel() {
  const [config, setConfig] = useState(null);
  const [saved, setSaved] = useState(null);
  const [source, setSource] = useState('defaults');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const { providers, loading } = useProviderModels({ filter: apiProvider, allowDefault: true, silent: true });
  const load = () => getSettings({ silent: true }).then(settings => {
    const policy = settings.untrustedContent || {};
    setConfig(policy); setSaved(JSON.stringify(policy)); setError('');
  }).catch(() => setError('Could not load content policies. Retry before editing.'));
  useEffect(() => { load(); }, []);

  const policy = source === 'defaults' ? config?.defaults || {} : config?.sources?.[source] || {};
  const isPrivate = PRIVATE_SOURCES.includes(source);
  const inheritedLayers = [config?.defaults || {}, isPrivate && source !== 'messages' ? config?.sources?.messages || {} : {}];
  const mergeLayers = layers => layers.reduce((merged, layer) => ({
    ...merged,
    ...(Object.hasOwn(layer, 'providerId') && layer.providerId !== merged.providerId ? { model: null } : {}),
    ...layer,
  }), {});
  const defaults = mergeLayers(inheritedLayers);
  const effective = mergeLayers([...inheritedLayers, policy]);
  const effectiveValue = name => effective[name];
  const inheritanceName = isPrivate && source !== 'messages' ? 'message defaults' : 'shared defaults';
  const selectedProvider = providers.find(provider => provider.id === effectiveValue('providerId'));
  const patch = fields => setConfig(current => source === 'defaults'
    ? { ...current, defaults: { ...current?.defaults, ...fields } }
    : { ...current, sources: { ...current?.sources, [source]: { ...current?.sources?.[source], ...fields } } });
  const changeNumber = (name, value) => {
    if (value !== '') patch({ [name]: Number(value) });
  };
  const save = () => {
    setSaving(true);
    updateSettings({ untrustedContent: config }).then(() => {
      setSaved(JSON.stringify(config));
      toast.success('Content safety policies saved');
    }).catch(() => {}).finally(() => setSaving(false));
  };

  return (
    <div className="border-t border-port-border pt-4 space-y-3 min-w-0">
      <h3 className="text-sm font-medium text-white">Content safety policies</h3>
      <p className="text-xs text-gray-400">Shared defaults apply to every source. Messages adds defaults for email, iMessage, and Signal; each channel can override them. Private message analysis stays on this machine. Screening never turns external text into instructions or gives the analysis model tools. GitHub review stages retain their separate schedule settings.</p>
      {error && <p role="alert" className="text-xs text-port-warning">{error} <button type="button" onClick={load} className="underline">Retry</button></p>}
      {!config ? !error && <p className="text-xs text-gray-500">Loading policies…</p> : (
        <form onSubmit={event => { event.preventDefault(); save(); }} className="space-y-3">
          <fieldset disabled={saving} className="space-y-3 min-w-0">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label htmlFor="abuse-policy-source" className="block text-xs text-gray-400 mb-1">Source</label>
                <select id="abuse-policy-source" value={source} onChange={event => setSource(event.target.value)} className={INPUT_CLASS}>
                  {SOURCES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                </select>
              </div>
              <div>
                <label htmlFor="abuse-policy-classifier" className="block text-xs text-gray-400 mb-1">Classifier requirement</label>
                <select id="abuse-policy-classifier" value={policy.classifierMode || ''} onChange={event => {
                  const value = event.target.value;
                  if (value) patch({ classifierMode: value });
                  else {
                    const { classifierMode: _classifierMode, ...rest } = policy;
                    setConfig(current => source === 'defaults' ? { ...current, defaults: rest } : { ...current, sources: { ...current.sources, [source]: rest } });
                  }
                }} className={INPUT_CLASS}>
                  <option value="">{source === 'defaults' ? 'Required (shipped default)' : `Inherit ${inheritanceName} (${defaults.classifierMode || 'required'})`}</option>
                  <option value="required">Required</option>
                  <option value="optional">Optional only when never installed</option>
                </select>
              </div>
            </div>
            {(policy.classifierMode || defaults.classifierMode) === 'optional' && <p className="text-xs text-port-warning">Optional allows deterministic screening alone on machines without the classifier. Those checks miss attacks the classifier could catch. Failed or partial installations still block.</p>}
            <ProviderModelSelector
              providers={providers}
              selectedProviderId={effectiveValue('providerId') || ''}
              selectedModel={effectiveValue('model') || ''}
              availableModels={selectedProvider?.models?.length ? selectedProvider.models : selectedProvider?.defaultModel ? [selectedProvider.defaultModel] : []}
              onProviderChange={providerId => patch({ providerId: providerId || null, model: null })}
              onModelChange={model => patch({ model: model || null })}
              label="Analysis API provider"
              loading={loading}
              selectionPolicy={{ provider: isPrivate ? localApiProvider : apiProvider }}
              emptyProviderOption="Automatic eligible API provider"
              emptyModelOption="Provider default model"
              alwaysShowModel
            />
            <p className="text-xs text-gray-500">{isPrivate ? 'Only local API endpoints are eligible for private messages. Cloud APIs, CLI agents, and provider fallback are blocked.' : 'Choose an API provider for text analysis. Automatic selection uses an eligible API provider; a failed provider never falls back. Cloud APIs may receive public GitHub content.'} <a href="/ai" className="text-port-accent hover:underline">Configure providers</a></p>
            <p className="text-xs text-gray-500">For long discussions, configure an adequate context window on the selected provider, such as 32K tokens. The character limits below never override the model&apos;s context capacity; evidence that cannot fit completely is blocked.</p>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              {[
                ['minBenignScore', 'Minimum benign score', 0.9, 1, 0.01, 0.9],
                ['maxInputChars', 'Input limit (characters)', 1000, 2000000, 1, 2000000],
                ['maxOutputChars', 'Output limit (characters)', 100, 100000, 1, 32000],
              ].map(([name, label, min, max, step, fallback]) => (
                <div key={name}>
                  <label htmlFor={`abuse-policy-${name}`} className="block text-xs text-gray-400 mb-1">{label}</label>
                  <input id={`abuse-policy-${name}`} className={INPUT_CLASS} type="number" min={min} max={max} step={step} required value={policy[name] ?? defaults[name] ?? fallback} onChange={event => changeNumber(name, event.target.value)} />
                </div>
              ))}
            </div>
          </fieldset>
          <div className="flex flex-wrap gap-2">
            <button type="submit" disabled={saving || JSON.stringify(config) === saved} className="px-3 py-2 text-xs rounded bg-port-accent text-white disabled:opacity-50">{saving ? 'Saving…' : 'Save content policies'}</button>
            {source !== 'defaults' && <button type="button" disabled={saving || !config.sources?.[source]} onClick={() => setConfig(current => {
              const sources = { ...current.sources };
              delete sources[source];
              return { ...current, sources };
            })} className="px-3 py-2 text-xs rounded border border-port-border text-gray-300 disabled:opacity-50">Use {inheritanceName} for this source</button>}
          </div>
        </form>
      )}
    </div>
  );
}
