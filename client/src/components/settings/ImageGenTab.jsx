import { useState, useEffect, useCallback } from 'react';
import { Save, Image, Zap, Wrench } from 'lucide-react';
import toast from '../ui/Toast';
import BrailleSpinner from '../BrailleSpinner';
import {
  getSettings, updateSettings, getImageGenStatus, registerTool, updateTool, getToolsList
} from '../../services/api';

const SDAPI_TOOL_ID = 'sdapi';

export function ImageGenTab() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [sdapiUrl, setSdapiUrl] = useState('');
  const [savedUrl, setSavedUrl] = useState('');
  const [status, setStatus] = useState(null);
  const [checking, setChecking] = useState(false);
  const [toolRegistered, setToolRegistered] = useState(false);

  useEffect(() => {
    Promise.all([getSettings(), getToolsList()])
      .then(([settings, tools]) => {
        const rawUrl = settings?.imageGen?.sdapiUrl || '';
        const normalizedUrl = rawUrl.trim().replace(/\/+$/, '');
        setSdapiUrl(normalizedUrl);
        setSavedUrl(normalizedUrl);
        setToolRegistered(tools.some(t => t.id === SDAPI_TOOL_ID));
      })
      .catch(() => toast.error('Failed to load image gen settings'))
      .finally(() => setLoading(false));
  }, []);

  const checkStatus = useCallback(() => {
    setChecking(true);
    getImageGenStatus()
      .then(setStatus)
      .catch(() => setStatus({ connected: false, reason: 'Check failed' }))
      .finally(() => setChecking(false));
  }, []);

  const handleSave = async () => {
    setSaving(true);
    const url = sdapiUrl.trim().replace(/\/+$/, '') || undefined;

    let settingsSaved = false;
    await updateSettings({ imageGen: { sdapiUrl: url } })
      .then(() => { settingsSaved = true; setSavedUrl(url || ''); toast.success('Image gen settings saved'); })
      .catch(() => toast.error('Failed to save settings'));

    if (!settingsSaved) {
      setSaving(false);
      return;
    }

    // Register or update the tool in the CoS tools registry
    const toolData = {
      name: 'Stable Diffusion',
      category: 'image-generation',
      description: 'Generate images via Stable Diffusion API (AUTOMATIC1111 / Forge WebUI)',
      enabled: !!url,
      config: { sdapiUrl: url },
      promptHints: 'Use POST /api/image-gen/generate with { prompt, negativePrompt, width, height, steps, cfgScale }. Use POST /api/image-gen/avatar for character portraits.'
    };
    if (toolRegistered) {
      await updateTool(SDAPI_TOOL_ID, toolData).catch(() => {
        toast.error('Failed to update CoS tools registry');
      });
    } else if (url) {
      await registerTool({ id: SDAPI_TOOL_ID, ...toolData })
        .then(() => setToolRegistered(true))
        .catch(() => {
          toast.error('Failed to register in CoS tools registry');
        });
    }

    setSaving(false);
  };

  if (loading) return <BrailleSpinner text="Loading image gen settings" />;

  return (
    <div className="bg-port-card border border-port-border rounded-xl p-6 space-y-5">
      <div className="flex items-center gap-2 text-white">
        <Image size={18} />
        <h2 className="text-lg font-semibold">Stable Diffusion API</h2>
      </div>

      <div className="space-y-1">
        <label className="block text-sm text-gray-400">API URL</label>
        <p className="text-xs text-gray-500 mb-1">
          Base URL for AUTOMATIC1111 / Forge WebUI (e.g. http://localhost:7860)
        </p>
        <input
          type="text"
          value={sdapiUrl}
          onChange={e => setSdapiUrl(e.target.value)}
          className="w-full bg-port-bg border border-port-border rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-port-accent"
          placeholder="http://localhost:7860"
        />
      </div>

      <div className="flex items-center gap-3">
        <button
          onClick={handleSave}
          disabled={saving}
          className="flex items-center gap-2 px-4 py-2 bg-port-accent hover:bg-port-accent/80 text-white text-sm rounded-lg transition-colors disabled:opacity-50"
        >
          {saving ? <BrailleSpinner /> : <Save size={14} />}
          Save
        </button>

        <button
          onClick={checkStatus}
          disabled={checking || !sdapiUrl.trim() || sdapiUrl.trim().replace(/\/+$/, '') !== savedUrl}
          className="flex items-center gap-2 px-4 py-2 bg-port-border hover:bg-port-border/70 text-white text-sm rounded-lg transition-colors disabled:opacity-50"
          title={sdapiUrl.trim().replace(/\/+$/, '') !== savedUrl ? 'Save settings first to test' : 'Test connection to SD API'}
        >
          {checking ? <BrailleSpinner /> : <Zap size={14} />}
          Test Connection
        </button>
      </div>

      {status && (
        <div className={`flex items-center gap-2 text-sm ${status.connected ? 'text-port-success' : 'text-port-error'}`}>
          <span className={`w-2 h-2 rounded-full ${status.connected ? 'bg-port-success' : 'bg-port-error'}`} />
          {status.connected ? `Connected — model: ${status.model}` : status.reason || 'Not connected'}
        </div>
      )}

      <div className="border-t border-port-border pt-4 space-y-2">
        <h3 className="text-sm font-medium text-gray-300">CoS Integration</h3>
        <p className="text-xs text-gray-500">
          When configured, this tool is registered with the CoS tools registry. Agents can use it to generate
          images for briefings, character avatars, and other visual content. Images are stored in <code className="text-gray-400">./data/images/</code>.
        </p>
        {toolRegistered && (
          <div className="flex items-center gap-2 text-xs text-port-success">
            <Wrench size={12} />
            Registered as CoS tool
          </div>
        )}
      </div>
    </div>
  );
}

export default ImageGenTab;
