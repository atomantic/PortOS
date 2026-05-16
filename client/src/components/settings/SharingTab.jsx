import { useEffect, useState } from 'react';
import { Save, Loader2, Users } from 'lucide-react';
import toast from '../ui/Toast';
import BrailleSpinner from '../BrailleSpinner';
import { getSettings, updateSettings } from '../../services/api';

export function SharingTab() {
  const [loading, setLoading] = useState(true);
  const [displayName, setDisplayName] = useState('');
  const [bio, setBio] = useState('');
  const [savedDisplayName, setSavedDisplayName] = useState('');
  const [savedBio, setSavedBio] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    getSettings({ silent: true })
      .then((settings) => {
        const display = settings?.sharingDisplayName || '';
        const b = settings?.sharingBio || '';
        setDisplayName(display);
        setBio(b);
        setSavedDisplayName(display);
        setSavedBio(b);
      })
      .catch(() => toast.error('Failed to load settings'))
      .finally(() => setLoading(false));
  }, []);

  const dirty = displayName !== savedDisplayName || bio !== savedBio;

  const handleSave = async () => {
    setSaving(true);
    const patch = {
      sharingDisplayName: displayName.trim(),
      sharingBio: bio.trim(),
    };
    const merged = await updateSettings(patch).catch(() => null);
    setSaving(false);
    if (!merged) return;
    setDisplayName(patch.sharingDisplayName);
    setBio(patch.sharingBio);
    setSavedDisplayName(patch.sharingDisplayName);
    setSavedBio(patch.sharingBio);
    toast.success('Saved');
  };

  if (loading) return <BrailleSpinner />;

  return (
    <div className="space-y-6">
      <div className="bg-port-card border border-port-border rounded-lg p-4 sm:p-6">
        <div className="flex items-center gap-2 mb-2">
          <Users size={16} className="text-port-accent" />
          <h3 className="text-lg font-semibold text-white">Sharing identity</h3>
        </div>
        <p className="text-sm text-gray-400 mb-4">
          This display name is stamped as the <em>source</em> on every share you send through the Sharing page.
          Recipients see it as attribution. Each bucket can override this with its own display name + bio.
        </p>
        <div className="space-y-3">
          <div>
            <label htmlFor="sharing-display-name" className="block text-xs uppercase tracking-wider text-gray-500 mb-1">Display name</label>
            <input
              id="sharing-display-name"
              type="text"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="Display name (e.g. atomantic)"
              maxLength={120}
              className="w-full sm:max-w-md px-3 py-2 bg-port-bg border border-port-border rounded text-white text-sm"
            />
          </div>
          <div>
            <label htmlFor="sharing-bio" className="block text-xs uppercase tracking-wider text-gray-500 mb-1">Bio (optional)</label>
            <textarea
              id="sharing-bio"
              value={bio}
              onChange={(e) => setBio(e.target.value)}
              placeholder="Optional bio / contact note (visible to recipients)"
              maxLength={2000}
              rows={3}
              className="w-full px-3 py-2 bg-port-bg border border-port-border rounded text-white text-sm resize-y"
            />
          </div>
          <div>
            <button
              type="button"
              onClick={handleSave}
              disabled={!dirty || saving}
              className="inline-flex items-center justify-center gap-2 min-h-[40px] px-4 py-2 bg-port-accent/20 hover:bg-port-accent/30 text-port-accent rounded-lg text-sm transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
              {saving ? 'Saving...' : 'Save'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default SharingTab;
