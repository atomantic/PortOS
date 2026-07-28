import { useState } from 'react';
import { MessageSquareText, Send } from 'lucide-react';
import ProviderModelSelector from '../ProviderModelSelector.jsx';
import EffortSelect from '../cos/EffortSelect.jsx';
import useProviderModels from '../../hooks/useProviderModels.js';
import { formatDateShort } from '../../utils/formatters.js';

export default function GameFeedback({ history, submitting, onSubmit }) {
  const [prompt, setPrompt] = useState('');
  const [effort, setEffort] = useState('');
  const {
    providers,
    selectedProviderId,
    selectedModel,
    availableModels,
    setSelectedProviderId,
    setSelectedModel,
    loading,
  } = useProviderModels({ silent: true });
  const selectedProvider = providers.find((provider) => provider.id === selectedProviderId);
  const promptId = 'game-feedback-prompt';

  const submit = async (event) => {
    event.preventDefault();
    if (!prompt.trim() || !selectedProviderId) return;
    const ok = await onSubmit({
      providerId: selectedProviderId,
      ...(selectedModel ? { model: selectedModel } : {}),
      ...(effort ? { effort } : {}),
      prompt: prompt.trim(),
    });
    if (ok) setPrompt('');
  };

  return (
    <section className="rounded-xl border border-port-border bg-port-card p-4">
      <div className="mb-3 flex items-center gap-2">
        <MessageSquareText className="h-5 w-5 text-port-accent" aria-hidden="true" />
        <h2 className="font-semibold text-white">AI feedback</h2>
      </div>
      <p className="mb-4 text-sm text-gray-400">
        Ask any configured provider to critique asset coverage and recommend the next improvements.
      </p>

      <form onSubmit={submit} className="space-y-3">
        <ProviderModelSelector
          providers={providers}
          selectedProviderId={selectedProviderId}
          selectedModel={selectedModel}
          availableModels={availableModels}
          onProviderChange={setSelectedProviderId}
          onModelChange={setSelectedModel}
          disabled={loading || submitting}
          layout="stacked"
        />
        <EffortSelect
          provider={selectedProvider}
          value={effort}
          onChange={setEffort}
          label="Thinking effort"
          disabled={submitting}
          className="w-full min-h-[44px] rounded-lg border border-port-border bg-port-bg px-3 py-2 text-sm text-white"
        />
        <div>
          <label htmlFor={promptId} className="mb-1 block text-xs text-gray-400">Review request</label>
          <textarea
            id={promptId}
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            maxLength={4000}
            rows={3}
            placeholder="What should the reviewer focus on?"
            className="w-full rounded-lg border border-port-border bg-port-bg px-3 py-2 text-sm text-white placeholder:text-gray-600"
            disabled={submitting}
          />
        </div>
        <button
          type="submit"
          disabled={submitting || loading || !selectedProviderId || !prompt.trim()}
          className="inline-flex min-h-[44px] items-center justify-center gap-2 rounded-lg bg-port-accent px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          <Send className="h-4 w-4" aria-hidden="true" />
          {submitting ? 'Reviewing…' : 'Request feedback'}
        </button>
      </form>

      {history.length > 0 ? (
        <div className="mt-6 space-y-3">
          <h3 className="text-sm font-medium text-gray-300">Feedback history</h3>
          {[...history].reverse().map((entry) => (
            <article key={entry.id} className="rounded-lg border border-port-border bg-port-bg/50 p-3">
              <div className="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-gray-500">
                <span>{entry.providerId}</span>
                {entry.model ? <span>· {entry.model}</span> : null}
                {entry.effort ? <span>· {entry.effort}</span> : null}
                <span>· {formatDateShort(entry.createdAt)}</span>
              </div>
              <p className="mb-2 text-xs italic text-gray-400">{entry.prompt}</p>
              <p className="whitespace-pre-wrap text-sm leading-6 text-gray-200">{entry.text}</p>
            </article>
          ))}
        </div>
      ) : null}
    </section>
  );
}
