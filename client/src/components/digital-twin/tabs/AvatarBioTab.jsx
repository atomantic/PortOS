import { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import useMounted from '../../../hooks/useMounted';
import {
  UserRound,
  Mic,
  BookOpen,
  Copy,
  Check,
  Sparkles,
  RefreshCw,
  AlertCircle
} from 'lucide-react';
import * as api from '../../../services/api';
import toast from '../../ui/Toast';
import BrailleSpinner from '../../BrailleSpinner';
import useProviderModels from '../../../hooks/useProviderModels';
import ProviderModelSelector from '../../ProviderModelSelector';
import { copyToClipboard } from '../../../lib/clipboard';

const LENGTHS = [
  { id: 'blurb', label: 'Blurb', hint: 'One tight paragraph per section' },
  { id: 'persona', label: 'Persona', hint: 'Balanced, avatar-ready' },
  { id: 'knowledge', label: 'Knowledge', hint: 'Fuller detail per section' }
];

const SECTION_META = [
  { key: 'whoIAm', title: 'Who I Am', icon: UserRound, accent: 'text-pink-400' },
  { key: 'howISpeak', title: 'How I Speak', icon: Mic, accent: 'text-port-accent' },
  { key: 'whatIKnow', title: 'What I Know', icon: BookOpen, accent: 'text-emerald-400' }
];

function CopyButton({ getText, label = 'Copy' }) {
  const [copied, setCopied] = useState(false);
  const onCopy = async () => {
    const ok = await copyToClipboard(getText(), 'Copied to clipboard');
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };
  return (
    <button
      onClick={onCopy}
      className="flex items-center gap-1.5 px-2.5 py-1.5 min-h-[36px] text-xs text-gray-400 hover:text-white rounded-md border border-port-border hover:border-gray-500 transition-colors"
      title={label}
    >
      {copied ? <Check size={14} className="text-port-success" /> : <Copy size={14} />}
      {copied ? 'Copied' : label}
    </button>
  );
}

export default function AvatarBioTab() {
  const navigate = useNavigate();
  const {
    providers, selectedProviderId, selectedModel, availableModels,
    setSelectedProviderId, setSelectedModel, loading: providersLoading
  } = useProviderModels();

  const [length, setLength] = useState('persona');
  const [bio, setBio] = useState(null);
  const [loading, setLoading] = useState(true);

  const [polishing, setPolishing] = useState(false);
  const [polished, setPolished] = useState(null);

  // Each length change starts a new generation. A slow in-flight load or refine
  // from a prior length bails on the generation check so its result can't
  // overwrite the current selection (leaving `polished`/`bio` mismatched with
  // the visible draft). `mountedRef` (via useMounted, which resets to true on
  // mount so StrictMode's mount→cleanup→remount doesn't strand it false) stops a
  // late resolution writing after unmount.
  const genRef = useRef(0);
  const mountedRef = useMounted();

  const loadBio = useCallback(async (len, gen) => {
    setLoading(true);
    // The deterministic build owns its own error UI here; silence the helper toast.
    const result = await api.getAvatarBio(len, { silent: true }).catch((err) => ({ error: err.message }));
    if (!mountedRef.current || gen !== genRef.current) return; // superseded by a newer length
    if (result?.error) {
      toast.error(result.error);
      setBio(null);
    } else {
      setBio(result);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    // New generation: reset the polish panel and reload the draft for this length.
    const gen = ++genRef.current;
    setPolished(null);
    setPolishing(false);
    loadBio(length, gen);
  }, [length, loadBio]);

  const handlePolish = async () => {
    if (!selectedProviderId || !selectedModel) {
      toast.error('Select a provider and model');
      return;
    }
    const gen = genRef.current;
    setPolishing(true);
    setPolished(null);
    const res = await api.polishAvatarBio(selectedProviderId, selectedModel, length, { silent: true })
      .catch((err) => ({ error: err.message }));

    if (!mountedRef.current || gen !== genRef.current) return; // length changed mid-refine — drop stale result
    if (res?.error && res.rawResponse) {
      setPolished(res); // surface the unparseable-response notice inline
    } else if (res?.error) {
      toast.error(res.error);
    } else {
      setPolished(res);
      toast.success('Avatar bio refined');
    }
    setPolishing(false);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <BrailleSpinner text="Loading" />
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-4xl mx-auto">
      {/* Intro */}
      <div className="bg-port-card rounded-lg border border-port-border p-6">
        <div className="flex items-start gap-3 mb-4">
          <UserRound className="w-6 h-6 text-pink-500 shrink-0 mt-0.5" />
          <div>
            <h2 className="text-lg font-semibold text-white">Live Avatar Bio</h2>
            <p className="text-sm text-gray-400">
              A concise, copy-ready persona for live-avatar platforms (HeyGen, Tavus, Simli,
              ElevenLabs agents). Assembled from your Digital Twin — no AI call needed. Optionally
              refine it into first-person prose with a provider.
            </p>
          </div>
        </div>

        {/* Length selector */}
        <div className="flex flex-wrap items-center gap-2">
          {LENGTHS.map(({ id, label, hint }) => (
            <button
              key={id}
              onClick={() => setLength(id)}
              title={hint}
              className={`px-3 py-1.5 min-h-[36px] rounded-md text-sm border transition-colors ${
                length === id
                  ? 'border-port-accent bg-port-accent/10 text-port-accent'
                  : 'border-port-border text-gray-400 hover:border-gray-500 hover:text-white'
              }`}
            >
              {label}
            </button>
          ))}
          {bio && (
            <span className="text-xs text-gray-500 ml-auto">~{bio.tokenEstimate?.toLocaleString()} tokens</span>
          )}
        </div>
      </div>

      {/* Voice-traits nudge */}
      {bio && !bio.hasVoiceTraits && (
        <div className="bg-port-warning/10 border border-port-warning/30 rounded-lg p-4 flex items-start gap-3">
          <AlertCircle className="w-5 h-5 text-port-warning shrink-0 mt-0.5" />
          <div className="text-sm text-gray-300">
            <p className="font-medium text-white mb-1">Voice profile not yet captured</p>
            <p className="mb-2">
              The <span className="text-white">How I Speak</span> section is qualitative only. For an avatar,
              cadence and verbal markers matter — generate a numeric voice profile to enrich it.
            </p>
            <div className="flex flex-wrap gap-2">
              <button
                onClick={() => navigate('/digital-twin/personality')}
                className="px-3 py-1.5 min-h-[36px] text-xs rounded-md border border-port-border hover:border-gray-500 text-gray-300 hover:text-white"
              >
                Analyze Personality
              </button>
              <button
                onClick={() => navigate('/digital-twin/voice')}
                className="px-3 py-1.5 min-h-[36px] text-xs rounded-md border border-port-border hover:border-gray-500 text-gray-300 hover:text-white"
              >
                Compare Voice & Style
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Section cards */}
      {bio && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-gray-400 uppercase tracking-wide">Draft</h3>
            <CopyButton getText={() => bio.combined} label="Copy all" />
          </div>

          {SECTION_META.map(({ key, title, icon: Icon, accent }) => (
            <div key={key} className="bg-port-card rounded-lg border border-port-border p-5">
              <div className="flex items-center justify-between mb-3">
                <h4 className={`flex items-center gap-2 text-sm font-semibold ${accent}`}>
                  <Icon size={16} /> {title}
                </h4>
                <CopyButton getText={() => bio.sections[key]} />
              </div>
              <p className="text-sm text-gray-300 whitespace-pre-wrap leading-relaxed">
                {bio.sections[key]}
              </p>
            </div>
          ))}
        </div>
      )}

      {/* AI polish */}
      <div className="bg-port-card rounded-lg border border-port-border p-6 space-y-4">
        <div className="flex items-center gap-2">
          <Sparkles className="w-5 h-5 text-port-accent" />
          <h3 className="text-base font-semibold text-white">Refine with AI (optional)</h3>
        </div>
        <p className="text-sm text-gray-400">
          Rewrite the draft into natural first-person prose. Only facts from your twin are used —
          nothing is invented.
        </p>

        {!providersLoading && providers.length > 0 && (
          <ProviderModelSelector
            providers={providers}
            selectedProviderId={selectedProviderId}
            selectedModel={selectedModel}
            availableModels={availableModels}
            onProviderChange={setSelectedProviderId}
            onModelChange={setSelectedModel}
            disabled={polishing}
          />
        )}

        <div className="flex justify-end">
          <button
            onClick={handlePolish}
            disabled={polishing || !selectedProviderId || !selectedModel}
            className="flex items-center gap-2 px-6 py-3 min-h-[48px] bg-port-accent text-white rounded-lg font-medium hover:bg-port-accent/80 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {polishing ? (
              <><RefreshCw size={18} className="animate-spin" /> Refining...</>
            ) : (
              <><Sparkles size={18} /> Refine with AI</>
            )}
          </button>
        </div>

        {polished && polished.content && (
          <div className="bg-port-bg rounded-lg border border-port-success/30 p-5 space-y-3">
            <div className="flex items-center justify-between">
              <h4 className="text-sm font-semibold text-port-success">Refined bio</h4>
              <div className="flex items-center gap-3">
                <span className="text-xs text-gray-500">~{polished.tokenEstimate?.toLocaleString()} tokens</span>
                <CopyButton getText={() => polished.content} />
              </div>
            </div>
            <pre className="text-sm text-gray-300 whitespace-pre-wrap font-sans leading-relaxed">
              {polished.content}
            </pre>
          </div>
        )}

        {polished && polished.error && polished.rawResponse && (
          <div className="flex items-center gap-3 text-sm text-gray-400">
            <AlertCircle size={16} className="text-port-warning" />
            The model response could not be parsed as an avatar bio.
          </div>
        )}
      </div>
    </div>
  );
}
