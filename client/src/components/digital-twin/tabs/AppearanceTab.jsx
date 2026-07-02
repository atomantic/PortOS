import { useState, useRef } from 'react';
import {
  Camera,
  RefreshCw,
  ScanFace,
  Check,
  Upload,
  X,
  AlertCircle
} from 'lucide-react';
import * as api from '../../../services/api';
import toast from '../../ui/Toast';
import useProviderModels from '../../../hooks/useProviderModels';
import ProviderModelSelector from '../../ProviderModelSelector';

// Cap the uploaded image so the base64 data URL stays well under the server's
// JSON body limit and vision providers don't choke on huge payloads.
const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10MB

// Mirror the server's identityImageInputSchema regex so an unsupported format
// (e.g. an iPhone HEIC) is rejected here with a clear message naming the real
// cause, instead of passing the loose image/* gate and failing a generic 400.
const ACCEPTED_MIME = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
const ACCEPT_ATTR = ACCEPTED_MIME.join(',');

const DETAIL_FIELDS = [
  { key: 'appearance', label: 'Appearance' },
  { key: 'presentation', label: 'Presentation' },
  { key: 'expression', label: 'Expression & demeanor' },
  { key: 'setting', label: 'Setting' }
];

export default function AppearanceTab({ onRefresh }) {
  const {
    providers, selectedProviderId, selectedModel, availableModels,
    setSelectedProviderId, setSelectedModel, loading: providersLoading
  } = useProviderModels();

  const fileInputRef = useRef(null);
  const [imageDataUrl, setImageDataUrl] = useState('');
  const [analyzing, setAnalyzing] = useState(false);
  const [result, setResult] = useState(null);
  const [docDraft, setDocDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const handleFile = (file) => {
    if (!file) return;
    if (!ACCEPTED_MIME.includes(file.type)) {
      toast.error('Unsupported format — use a PNG, JPEG, GIF, or WebP image');
      return;
    }
    if (file.size > MAX_IMAGE_BYTES) {
      toast.error('Image is too large (max 10MB)');
      return;
    }
    const reader = new FileReader();
    reader.onload = (e) => {
      setImageDataUrl(e.target.result);
      setResult(null);
      setDocDraft('');
      setSaved(false);
    };
    reader.onerror = () => toast.error('Could not read that image');
    reader.readAsDataURL(file);
  };

  const clearImage = () => {
    setImageDataUrl('');
    setResult(null);
    setDocDraft('');
    setSaved(false);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handleAnalyze = async () => {
    if (!imageDataUrl) {
      toast.error('Choose a photo first');
      return;
    }
    if (!selectedProviderId || !selectedModel) {
      toast.error('Select a provider and model');
      return;
    }

    setAnalyzing(true);
    setResult(null);
    setDocDraft('');
    setSaved(false);

    const res = await api.analyzeIdentityImage(
      { imageDataUrl, providerId: selectedProviderId, model: selectedModel },
      { silent: true }
    ).catch((err) => ({ error: err.message }));

    if (res.error && res.rawResponse) {
      // The model replied but its output couldn't be parsed — surface it inline.
      setResult(res);
    } else if (res.error) {
      toast.error(res.error);
    } else {
      setResult(res);
      setDocDraft(res.suggestedDocument?.content || '');
      toast.success('Image analyzed');
    }
    setAnalyzing(false);
  };

  const handleSave = async () => {
    const content = docDraft.trim();
    if (!content) return;

    setSaving(true);
    const res = await api.saveIdentityImageDocument(
      { content, title: result?.suggestedDocument?.title },
      { silent: true }
    ).catch((err) => ({ error: err.message }));

    if (res?.error) {
      toast.error(res.error);
    } else {
      setSaved(true);
      toast.success('Saved to Appearance & Presentation document');
      onRefresh?.();
    }
    setSaving(false);
  };

  return (
    <div className="space-y-6 max-w-4xl mx-auto">
      {/* Inputs */}
      <div className="bg-port-card rounded-lg border border-port-border p-6">
        <div className="flex items-center gap-3 mb-4">
          <Camera className="w-6 h-6 text-port-accent" />
          <div>
            <h2 className="text-lg font-semibold text-white">Appearance from a Photo</h2>
            <p className="text-sm text-gray-400">
              Upload a photo of yourself and a vision model extracts your visible appearance and
              self-presentation, which you can save as a Digital Twin identity document. Use a
              local vision provider (LM Studio / Ollama) to keep the photo on-device.
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
              disabled={analyzing}
            />
          )}

          <div>
            <label htmlFor="appearance-image" className="block text-sm font-medium text-gray-300 mb-1">
              Photo
            </label>
            <input
              id="appearance-image"
              ref={fileInputRef}
              type="file"
              accept={ACCEPT_ATTR}
              onChange={(e) => handleFile(e.target.files?.[0])}
              disabled={analyzing}
              className="hidden"
            />
            {!imageDataUrl ? (
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={analyzing}
                className="flex items-center gap-2 px-4 py-3 min-h-[48px] w-full justify-center border border-dashed border-port-border rounded-lg text-gray-400 hover:border-port-accent hover:text-white transition-colors disabled:opacity-50"
              >
                <Upload size={18} /> Choose a photo (max 10MB)
              </button>
            ) : (
              <div className="relative inline-block">
                <img
                  src={imageDataUrl}
                  alt="Selected"
                  className="max-h-64 rounded-lg border border-port-border"
                />
                <button
                  type="button"
                  onClick={clearImage}
                  disabled={analyzing}
                  aria-label="Remove photo"
                  className="absolute top-2 right-2 p-1.5 bg-port-bg/90 border border-port-border rounded-full text-gray-300 hover:text-white disabled:opacity-50"
                >
                  <X size={16} />
                </button>
              </div>
            )}
          </div>

          <div className="flex justify-end">
            <button
              onClick={handleAnalyze}
              disabled={analyzing || !imageDataUrl || !selectedProviderId || !selectedModel}
              className="flex items-center gap-2 px-6 py-3 min-h-[48px] bg-port-accent text-white rounded-lg font-medium hover:bg-port-accent/80 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {analyzing ? (
                <><RefreshCw size={18} className="animate-spin" /> Analyzing...</>
              ) : (
                <><ScanFace size={18} /> Analyze</>
              )}
            </button>
          </div>
        </div>
      </div>

      {/* Results */}
      {result && (
        <div className="bg-port-card rounded-lg border border-port-success/30 p-6 space-y-5">
          <div className="flex items-center gap-3">
            <ScanFace className="w-6 h-6 text-port-success" />
            <h2 className="text-lg font-semibold text-white">Appearance analysis</h2>
          </div>

          {result.summary && (
            <p className="text-sm text-gray-300">{result.summary}</p>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {DETAIL_FIELDS.map(({ key, label }) => (
              result[key] && (
                <div key={key} className="bg-port-bg rounded-lg border border-port-border p-4">
                  <h4 className="text-sm font-semibold text-port-accent mb-2">{label}</h4>
                  <p className="text-sm text-gray-300">{result[key]}</p>
                </div>
              )
            ))}
          </div>

          {Array.isArray(result.descriptors) && result.descriptors.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {result.descriptors.map((d, i) => (
                <span key={i} className="text-xs px-2 py-0.5 rounded-full bg-port-border/60 text-gray-300">
                  {d}
                </span>
              ))}
            </div>
          )}

          {result.suggestedDocument && (
            <div className="bg-port-bg rounded-lg border border-port-accent/30 p-4 space-y-3">
              <div>
                <label htmlFor="appearance-doc" className="block text-sm font-semibold text-white mb-1">
                  Identity document
                </label>
                <p className="text-xs text-gray-500 mb-2">
                  Edit if needed, then save. This updates your <span className="text-gray-300">Appearance &amp; Presentation</span> core document.
                </p>
                <textarea
                  id="appearance-doc"
                  value={docDraft}
                  onChange={(e) => { setDocDraft(e.target.value); setSaved(false); }}
                  rows={10}
                  className="w-full px-4 py-3 bg-port-card border border-port-border rounded-lg text-white text-sm font-mono resize-y focus:outline-hidden focus:border-port-accent"
                />
              </div>
              <button
                onClick={handleSave}
                disabled={saving || saved || !docDraft.trim()}
                className="flex items-center gap-2 px-4 py-2 min-h-[44px] bg-port-accent text-white rounded-lg text-sm font-medium hover:bg-port-accent/80 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {saved ? (
                  <><Check size={16} /> Saved</>
                ) : saving ? (
                  <><RefreshCw size={16} className="animate-spin" /> Saving...</>
                ) : (
                  'Save as identity document'
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
