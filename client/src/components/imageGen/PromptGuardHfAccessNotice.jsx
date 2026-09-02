import { useEffect, useState } from 'react';
import { KeyRound, Loader2 } from 'lucide-react';
import HfTokenBanner, { GatedModelList, HF_SOURCE_LABEL } from './HfTokenBanner';

const DEFAULT_MODEL = {
  name: 'Llama Prompt Guard 2 86M',
  sourceUrl: 'https://huggingface.co/meta-llama/Llama-Prompt-Guard-2-86M',
};

/**
 * Hugging Face access prerequisite for the managed Prompt Guard classifier.
 *
 * A token and gated-model approval are separate facts: the token can already be
 * configured while the model owner still has to approve the usage request. The
 * caller supplies the central tri-state token status so an unavailable status
 * check never flashes a false "add a token" form.
 */
export default function PromptGuardHfAccessNotice({ tokenPresent, tokenSource, model, onSaved }) {
  const [replacing, setReplacing] = useState(false);
  const resolvedModel = {
    name: typeof model?.name === 'string' && model.name.trim() ? model.name.trim() : DEFAULT_MODEL.name,
    sourceUrl: typeof model?.sourceUrl === 'string' && model.sourceUrl.trim()
      ? model.sourceUrl.trim()
      : DEFAULT_MODEL.sourceUrl,
  };
  const accessModel = {
    label: resolvedModel.name,
    url: resolvedModel.sourceUrl,
    linkLabel: 'Open model card and submit usage request',
  };

  useEffect(() => {
    if (!tokenPresent) setReplacing(false);
  }, [tokenPresent]);

  const handleSaved = () => {
    setReplacing(false);
    onSaved?.();
  };

  if (tokenPresent === null) {
    return (
      <div className="flex items-center gap-2 text-xs text-gray-400" data-testid="prompt-guard-hf-checking">
        <Loader2 size={14} className="animate-spin" />
        Checking Hugging Face token status…
      </div>
    );
  }

  if (!tokenPresent || replacing) {
    return (
      <div data-testid="prompt-guard-hf-token-entry" className="space-y-2">
        <p className="text-xs text-port-warning">
          Prompt Guard is a gated Hugging Face model. Submit the usage request on its model card and accept
          any terms before installing; the token below only authenticates the download.
        </p>
        <HfTokenBanner models={[accessModel]} onSaved={handleSaved} />
      </div>
    );
  }

  return (
    <div data-testid="prompt-guard-hf-access" className="rounded-lg border border-port-border bg-port-bg/40 p-3 text-xs text-gray-400">
      <div className="flex items-center gap-1.5 font-medium text-port-success">
        <KeyRound className="h-3.5 w-3.5" />
        Hugging Face token configured
        {HF_SOURCE_LABEL[tokenSource] ? ` (${HF_SOURCE_LABEL[tokenSource]})` : ''}
      </div>
      <p className="mt-1">
        A token does not grant gated access by itself. Submit the usage request and accept the model terms
        on your Hugging Face account before retrying the install:
      </p>
      <GatedModelList models={[accessModel]} linkClassName="text-port-accent hover:underline" />
      <button
        type="button"
        onClick={() => setReplacing(true)}
        className="mt-2 text-xs underline text-gray-400 hover:text-white"
      >
        Use a different token
      </button>
    </div>
  );
}
