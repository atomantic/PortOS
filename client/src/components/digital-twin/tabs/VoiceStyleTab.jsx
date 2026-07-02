import { useState } from 'react';
import {
  Mic,
  RefreshCw,
  GitCompareArrows,
  Check,
  AlertCircle
} from 'lucide-react';
import * as api from '../../../services/api';
import toast from '../../ui/Toast';
import useProviderModels from '../../../hooks/useProviderModels';
import ProviderModelSelector from '../../ProviderModelSelector';

const MIN_TRANSCRIPT = 100;

// Scale fields rendered as numbers; everything else is shown as free text.
const SCALE_FIELDS = [
  { key: 'formality', label: 'Formality', suffix: '/10' },
  { key: 'verbosity', label: 'Verbosity', suffix: '/10' },
  { key: 'directness', label: 'Directness', suffix: '/10' },
  { key: 'avgSentenceLength', label: 'Avg sentence', suffix: ' words' }
];

function ProfileCard({ title, profile, accent }) {
  if (!profile) return null;
  return (
    <div className="bg-port-bg rounded-lg border border-port-border p-4">
      <h4 className={`text-sm font-semibold mb-3 ${accent}`}>{title}</h4>
      <div className="grid grid-cols-2 gap-2 mb-3">
        {SCALE_FIELDS.map(({ key, label, suffix }) => (
          profile[key] != null && (
            <div key={key} className="flex items-baseline justify-between gap-2">
              <span className="text-xs text-gray-500">{label}</span>
              <span className="text-sm text-white font-medium">
                {profile[key]}{suffix}
              </span>
            </div>
          )
        ))}
      </div>
      {profile.fillerWords && (
        <p className="text-xs text-gray-400 mb-2">
          <span className="text-gray-500">Filler: </span>{profile.fillerWords}
        </p>
      )}
      {Array.isArray(profile.distinctiveMarkers) && profile.distinctiveMarkers.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {profile.distinctiveMarkers.map((m, i) => (
            <span key={i} className="text-xs px-2 py-0.5 rounded-full bg-port-border/60 text-gray-300">
              {m}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

export default function VoiceStyleTab({ onRefresh }) {
  const {
    providers, selectedProviderId, selectedModel, availableModels,
    setSelectedProviderId, setSelectedModel, loading: providersLoading
  } = useProviderModels();

  const [transcript, setTranscript] = useState('');
  const [written, setWritten] = useState('');
  const [comparing, setComparing] = useState(false);
  const [result, setResult] = useState(null);
  const [applying, setApplying] = useState(false);
  const [applied, setApplied] = useState(false);

  const handleCompare = async () => {
    if (transcript.trim().length < MIN_TRANSCRIPT) {
      toast.error(`Spoken transcript must be at least ${MIN_TRANSCRIPT} characters`);
      return;
    }
    if (!selectedProviderId || !selectedModel) {
      toast.error('Select a provider and model');
      return;
    }

    setComparing(true);
    setResult(null);
    setApplied(false);

    const payload = {
      spokenTranscript: transcript.trim(),
      providerId: selectedProviderId,
      model: selectedModel
    };
    // Only send written samples when the user pasted some; otherwise the
    // server falls back to the twin's documents.
    if (written.trim().length >= 10) {
      payload.writtenSamples = [written.trim()];
    }

    const res = await api.compareSpokenWrittenStyle(payload, { silent: true })
      .catch((err) => ({ error: err.message }));

    if (res.error && res.rawResponse) {
      // The model replied but its output couldn't be parsed — surface the
      // unparseable-response notice inline instead of only a transient toast.
      setResult(res);
    } else if (res.error) {
      toast.error(res.error);
    } else {
      setResult(res);
      toast.success('Style comparison complete');
    }
    setComparing(false);
  };

  const handleApply = async () => {
    const suggested = result?.suggestedCommunicationProfile;
    if (!suggested) return;

    setApplying(true);
    // Forward only the fields the communicationProfile schema accepts.
    const communicationProfile = {};
    ['formality', 'verbosity', 'emojiUsage', 'preferredTone'].forEach((k) => {
      if (suggested[k] != null) communicationProfile[k] = suggested[k];
    });

    const res = await api.updateDigitalTwinTraits({ communicationProfile }, { silent: true })
      .catch((err) => ({ error: err.message }));

    if (res?.error) {
      toast.error(res.error);
    } else {
      setApplied(true);
      toast.success('Applied to communication profile');
      onRefresh?.();
    }
    setApplying(false);
  };

  return (
    <div className="space-y-6 max-w-4xl mx-auto">
      {/* Inputs */}
      <div className="bg-port-card rounded-lg border border-port-border p-6">
        <div className="flex items-center gap-3 mb-4">
          <Mic className="w-6 h-6 text-port-accent" />
          <div>
            <h2 className="text-lg font-semibold text-white">Spoken vs. Written Style</h2>
            <p className="text-sm text-gray-400">
              Paste a transcript of yourself speaking and compare it against how you write.
              Surfaces the gap and suggests a voice-context communication profile.
            </p>
          </div>
        </div>

        <div className="space-y-4">
          {!providersLoading && providers.length > 0 && (
            <ProviderModelSelector
              providers={providers}
              selectedProviderId={selectedProviderId}
              selectedModel={selectedModel}
              availableModels={availableModels}
              onProviderChange={setSelectedProviderId}
              onModelChange={setSelectedModel}
              disabled={comparing}
            />
          )}

          <div>
            <label htmlFor="voice-transcript" className="block text-sm font-medium text-gray-300 mb-1">
              Spoken transcript
            </label>
            <textarea
              id="voice-transcript"
              value={transcript}
              onChange={(e) => setTranscript(e.target.value)}
              placeholder="Paste a transcript of yourself speaking — a voice memo transcription, a meeting/podcast transcript, dictated notes..."
              rows={7}
              className="w-full px-4 py-3 bg-port-bg border border-port-border rounded-lg text-white resize-y focus:outline-hidden focus:border-port-accent placeholder-gray-600"
              disabled={comparing}
            />
            <span className="text-xs text-gray-500">
              {transcript.length} characters {transcript.length > 0 && transcript.length < MIN_TRANSCRIPT && `(need ${MIN_TRANSCRIPT}+)`}
            </span>
          </div>

          <div>
            <label htmlFor="voice-written" className="block text-sm font-medium text-gray-300 mb-1">
              Written sample <span className="text-gray-500 font-normal">(optional)</span>
            </label>
            <textarea
              id="voice-written"
              value={written}
              onChange={(e) => setWritten(e.target.value)}
              placeholder="Optionally paste a sample of your writing. Leave blank to compare against your existing Digital Twin documents."
              rows={5}
              className="w-full px-4 py-3 bg-port-bg border border-port-border rounded-lg text-white resize-y focus:outline-hidden focus:border-port-accent placeholder-gray-600"
              disabled={comparing}
            />
          </div>

          <div className="flex justify-end">
            <button
              onClick={handleCompare}
              disabled={comparing || transcript.trim().length < MIN_TRANSCRIPT || !selectedProviderId || !selectedModel}
              className="flex items-center gap-2 px-6 py-3 min-h-[48px] bg-port-accent text-white rounded-lg font-medium hover:bg-port-accent/80 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {comparing ? (
                <><RefreshCw size={18} className="animate-spin" /> Comparing...</>
              ) : (
                <><GitCompareArrows size={18} /> Compare</>
              )}
            </button>
          </div>
        </div>
      </div>

      {/* Results */}
      {result && (
        <div className="bg-port-card rounded-lg border border-port-success/30 p-6 space-y-5">
          <div className="flex items-center gap-3">
            <GitCompareArrows className="w-6 h-6 text-port-success" />
            <h2 className="text-lg font-semibold text-white">Comparison</h2>
            {result.writtenSource === 'documents' && (
              <span className="text-xs text-gray-500">(written style from your documents)</span>
            )}
          </div>

          {result.summary && (
            <p className="text-sm text-gray-300">{result.summary}</p>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <ProfileCard title="Spoken" profile={result.spokenProfile} accent="text-port-accent" />
            <ProfileCard title="Written" profile={result.writtenProfile} accent="text-pink-400" />
          </div>

          {Array.isArray(result.differences) && result.differences.length > 0 && (
            <div>
              <h4 className="text-sm font-semibold text-white mb-2">Key differences</h4>
              <div className="space-y-2">
                {result.differences.map((d, i) => (
                  <div key={i} className="bg-port-bg rounded-lg border border-port-border p-3">
                    <div className="flex items-center justify-between gap-2 mb-1">
                      <span className="text-sm font-medium text-white capitalize">
                        {String(d.dimension || '').replace(/_/g, ' ')}
                      </span>
                    </div>
                    <div className="grid grid-cols-2 gap-2 text-xs mb-1">
                      <span className="text-gray-400"><span className="text-port-accent">Spoken:</span> {d.spoken}</span>
                      <span className="text-gray-400"><span className="text-pink-400">Written:</span> {d.written}</span>
                    </div>
                    {d.note && <p className="text-xs text-gray-500">{d.note}</p>}
                  </div>
                ))}
              </div>
            </div>
          )}

          {result.suggestedCommunicationProfile && (
            <div className="bg-port-bg rounded-lg border border-port-accent/30 p-4">
              <h4 className="text-sm font-semibold text-white mb-2">Suggested voice profile</h4>
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-gray-300 mb-3">
                {result.suggestedCommunicationProfile.formality != null && (
                  <span><span className="text-gray-500">Formality:</span> {result.suggestedCommunicationProfile.formality}/10</span>
                )}
                {result.suggestedCommunicationProfile.verbosity != null && (
                  <span><span className="text-gray-500">Verbosity:</span> {result.suggestedCommunicationProfile.verbosity}/10</span>
                )}
                {result.suggestedCommunicationProfile.emojiUsage && (
                  <span><span className="text-gray-500">Emoji:</span> {result.suggestedCommunicationProfile.emojiUsage}</span>
                )}
                {result.suggestedCommunicationProfile.preferredTone && (
                  <span><span className="text-gray-500">Tone:</span> {result.suggestedCommunicationProfile.preferredTone}</span>
                )}
              </div>
              <button
                onClick={handleApply}
                disabled={applying || applied}
                className="flex items-center gap-2 px-4 py-2 min-h-[44px] bg-port-accent text-white rounded-lg text-sm font-medium hover:bg-port-accent/80 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {applied ? (
                  <><Check size={16} /> Applied</>
                ) : applying ? (
                  <><RefreshCw size={16} className="animate-spin" /> Applying...</>
                ) : (
                  'Apply to communication profile'
                )}
              </button>
            </div>
          )}

          {result.rawResponse && !result.summary && (
            <div className="flex items-center gap-3 text-sm text-gray-400">
              <AlertCircle size={16} className="text-port-warning" />
              The model response could not be parsed as structured data.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
