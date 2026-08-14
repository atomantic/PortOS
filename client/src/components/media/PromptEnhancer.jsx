import { useState, useEffect } from 'react';
import { Sparkles, Wand2, ChevronDown, ChevronUp } from 'lucide-react';
import ProviderModelSelector from '../ProviderModelSelector';
import useProviderModels from '../../hooks/useProviderModels';
import { refineMediaPrompt } from '../../services/api';
import toast from '../ui/Toast';
import BrailleSpinner from '../BrailleSpinner';

const LS_KEY_PROVIDER = 'portos_enhance_prompt_provider';
const LS_KEY_MODEL = 'portos_enhance_prompt_model';
const LS_KEY_EFFORT = 'portos_enhance_prompt_effort';

export default function PromptEnhancer({
  kind = 'image', // 'image' | 'video'
  prompt,
  setPrompt,
  negativePrompt = '',
  setNegativePrompt,
  renderConfig = {},
  disabled = false,
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [effort, setEffort] = useState(() => {
    try {
      return localStorage.getItem(LS_KEY_EFFORT) || '';
    } catch {
      return '';
    }
  });
  const [enhancing, setEnhancing] = useState(false);

  const {
    providers,
    selectedProviderId,
    selectedModel,
    availableModels,
    setSelectedProviderId,
    setSelectedModel,
    loading: providersLoading,
  } = useProviderModels({ silent: true, withEffort: true });

  // Restore saved provider / model preference once provider list loads
  useEffect(() => {
    if (providersLoading || !providers.length) return;
    try {
      const savedProvider = localStorage.getItem(LS_KEY_PROVIDER);
      const savedModel = localStorage.getItem(LS_KEY_MODEL);
      if (savedProvider && providers.some((p) => p.id === savedProvider)) {
        setSelectedProviderId(savedProvider);
        if (savedModel) {
          setSelectedModel(savedModel);
        }
      }
    } catch {
      // Ignore localStorage errors
    }
  }, [providers, providersLoading, setSelectedProviderId, setSelectedModel]);

  const handleProviderChange = (id) => {
    setSelectedProviderId(id);
    setEffort('');
    try {
      if (id) {
        localStorage.setItem(LS_KEY_PROVIDER, id);
      } else {
        localStorage.removeItem(LS_KEY_PROVIDER);
      }
      localStorage.removeItem(LS_KEY_MODEL);
      localStorage.removeItem(LS_KEY_EFFORT);
    } catch {
      // Ignore localStorage errors
    }
  };

  const handleModelChange = (model) => {
    setSelectedModel(model);
    try {
      if (selectedProviderId) localStorage.setItem(LS_KEY_PROVIDER, selectedProviderId);
      if (model) {
        localStorage.setItem(LS_KEY_MODEL, model);
      } else {
        localStorage.removeItem(LS_KEY_MODEL);
      }
    } catch {
      // Ignore localStorage errors
    }
  };

  const handleEffortChange = (val) => {
    setEffort(val);
    try {
      if (val) {
        localStorage.setItem(LS_KEY_EFFORT, val);
      } else {
        localStorage.removeItem(LS_KEY_EFFORT);
      }
    } catch {
      // Ignore localStorage errors
    }
  };

  const handleEnhance = async () => {
    if (!selectedProviderId) {
      toast.error('Please select an AI provider to enhance prompt');
      return;
    }
    if (!prompt || !prompt.trim()) {
      toast.error('Please enter a prompt to enhance');
      return;
    }

    setEnhancing(true);
    try {
      const result = await refineMediaPrompt({
        kind,
        prompt: prompt.trim(),
        negativePrompt: negativePrompt?.trim() || '',
        providerId: selectedProviderId,
        model: selectedModel || undefined,
        effort: effort || undefined,
        renderConfig,
      });

      if (result?.prompt) {
        setPrompt(result.prompt);
        if (setNegativePrompt && result.negativePrompt != null) {
          setNegativePrompt(result.negativePrompt);
        }
        toast.success('Prompt enhanced!');
      }
    } catch {
      // refineMediaPrompt routes through request() which already toasts on error
    } finally {
      setEnhancing(false);
    }
  };

  return (
    <div className="space-y-2 my-1">
      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={() => setIsOpen((prev) => !prev)}
          disabled={disabled || enhancing}
          className="inline-flex items-center gap-1.5 text-xs text-port-accent hover:text-port-accent/80 font-medium transition-colors disabled:opacity-50 min-h-[36px] px-1"
          aria-expanded={isOpen}
          aria-label="Toggle AI prompt enhancement options"
        >
          <Sparkles className="w-3.5 h-3.5" />
          <span>Enhance with AI</span>
          {isOpen ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
        </button>

        {!isOpen && (
          <button
            type="button"
            onClick={handleEnhance}
            disabled={disabled || enhancing || !prompt?.trim() || !selectedProviderId}
            className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-port-accent/15 border border-port-accent/30 text-port-accent text-xs font-medium hover:bg-port-accent/25 transition-colors disabled:opacity-50 min-h-[32px]"
            title="Enhance prompt with currently selected AI provider"
          >
            {enhancing ? (
              <>
                <BrailleSpinner />
                <span>Enhancing…</span>
              </>
            ) : (
              <>
                <Wand2 className="w-3.5 h-3.5" />
                <span>Enhance</span>
              </>
            )}
          </button>
        )}
      </div>

      {isOpen && (
        <div className="p-3 bg-port-bg/70 border border-port-border rounded-lg space-y-3">
          <div className="text-xs font-semibold text-gray-300 flex items-center justify-between">
            <span>AI Prompt Enhancer Settings</span>
          </div>

          <ProviderModelSelector
            providers={providers}
            selectedProviderId={selectedProviderId}
            selectedModel={selectedModel}
            availableModels={availableModels}
            onProviderChange={handleProviderChange}
            onModelChange={handleModelChange}
            effort={effort}
            onEffortChange={handleEffortChange}
            disabled={disabled || enhancing || providersLoading}
            layout="stacked"
          />

          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={handleEnhance}
              disabled={disabled || enhancing || !prompt?.trim() || !selectedProviderId}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-port-accent text-white text-xs font-medium hover:bg-port-accent/80 transition-colors disabled:opacity-50 min-h-[36px]"
            >
              {enhancing ? (
                <>
                  <BrailleSpinner />
                  <span>Enhancing Prompt…</span>
                </>
              ) : (
                <>
                  <Sparkles className="w-3.5 h-3.5" />
                  <span>Enhance Prompt</span>
                </>
              )}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
