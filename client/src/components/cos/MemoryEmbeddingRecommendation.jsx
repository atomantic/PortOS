import { useState } from 'react';
import { Link } from 'react-router';
import { Download } from 'lucide-react';
import { installLocalLlmModel } from '../../services/apiLocalLlm';
import { useAsyncAction } from '../../hooks/useAsyncAction';

const MODEL = 'nomic-embed-text';

export default function MemoryEmbeddingRecommendation({ onSelect, disabled }) {
  const [installed, setInstalled] = useState(false);
  const [install, installing] = useAsyncAction(async () => {
    const result = await installLocalLlmModel('ollama', MODEL, { silent: true });
    if (result.success && !result.pending) setInstalled(true);
  });
  const [select, selecting] = useAsyncAction(() => onSelect('ollama', MODEL));

  return (
    <div className="mt-4 space-y-2 border-t border-port-border pt-4">
      <p className="text-sm text-port-text">
        Recommended: <strong>nomic-embed-text</strong> on Ollama
      </p>
      <p className="text-xs text-port-text-muted">
        A dedicated text embedding model for semantic memory retrieval (768 dimensions, about 274 MB).
        Chat models may not support embeddings. Download runs on this PortOS machine and requires Ollama.
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" disabled={installing || selecting || disabled}
          onClick={() => installed ? select() : install()}
          className="inline-flex items-center gap-2 rounded-lg bg-port-accent px-3 py-2 text-sm text-white disabled:opacity-50">
          <Download size={14} aria-hidden="true" />
          {installing ? 'Downloading nomic-embed-text…' : selecting ? 'Saving…' : installed ? 'Use for memory embeddings' : 'Download nomic-embed-text'}
        </button>
        <Link to="/models/llms-runtimes" className="text-xs text-port-accent hover:underline">Manage Ollama</Link>
      </div>
      <p role="status" className="text-xs text-port-text-muted">
        {installed ? 'Installed locally. Use for memory embeddings to save Ollama and this model.' : 'Your saved provider and model stay in place until you choose Use for memory embeddings.'}
      </p>
    </div>
  );
}
