import { useState, useEffect, useMemo } from 'react';
import { Save } from 'lucide-react';
import toast from '../ui/Toast';
import BrailleSpinner from '../BrailleSpinner';
import ThemePickerPanel from '../ThemePickerPanel';
import { getSettings, updateSettings } from '../../services/api';

export function GeneralTab() {
  const [loading, setLoading] = useState(true);
  const [timezone, setTimezone] = useState('');
  const [saving, setSaving] = useState(false);
  const detectedTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const allTimezones = useMemo(() => Intl.supportedValuesOf?.('timeZone') ?? [], []);

  useEffect(() => {
    getSettings()
      .then(settings => setTimezone(settings?.timezone || ''))
      .catch(() => toast.error('Failed to load settings'))
      .finally(() => setLoading(false));
  }, []);

  const handleSave = async (tz) => {
    const tzToSave = tz || detectedTz;
    if (!tzToSave) {
      toast.error('Timezone is required.');
      return;
    }

    // Validate timezone string
    let isValid = false;
    if (allTimezones.length > 0) {
      isValid = allTimezones.includes(tzToSave);
    } else {
      try {
        new Intl.DateTimeFormat('en-US', { timeZone: tzToSave });
        isValid = true;
      } catch { isValid = false; }
    }
    if (!isValid) {
      toast.error('Invalid timezone. Please select a valid IANA timezone.');
      return;
    }

    setSaving(true);
    try {
      await updateSettings({ timezone: tzToSave });
      setTimezone(tzToSave);
      toast.success(`Timezone set to ${tzToSave}`);
    } catch (err) {
      toast.error(err.message || 'Failed to save timezone');
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <BrailleSpinner />;

  return (
    <div className="space-y-6">
      <div className="bg-port-card border border-port-border rounded-lg p-6">
        <h3 className="text-lg font-semibold text-white mb-4">Interface Theme</h3>
        <ThemePickerPanel />
      </div>

      <div className="bg-port-card border border-port-border rounded-lg p-6">
        <h3 className="text-lg font-semibold text-white mb-4">Timezone</h3>
        <p className="text-sm text-gray-400 mb-4">
          Used for job scheduling (cron expressions & scheduled times) and briefing dates.
        </p>
        <div className="flex items-center gap-3">
          <input
            type="text"
            value={timezone}
            onChange={e => setTimezone(e.target.value)}
            placeholder={detectedTz}
            className="flex-1 max-w-xs px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white text-sm"
            list="tz-list"
          />
          <button
            onClick={() => handleSave(timezone)}
            disabled={saving}
            className="px-4 py-2 bg-port-accent/20 hover:bg-port-accent/30 text-port-accent rounded-lg text-sm transition-colors disabled:opacity-50"
          >
            <Save size={14} className="inline mr-1" />
            {saving ? 'Saving...' : 'Save'}
          </button>
          {!timezone && (
            <button
              onClick={() => handleSave(detectedTz)}
              disabled={saving}
              className="px-3 py-2 text-sm text-gray-400 hover:text-white transition-colors"
            >
              Use detected: {detectedTz}
            </button>
          )}
        </div>
        {timezone && timezone !== detectedTz && (
          <p className="text-xs text-gray-500 mt-2">
            Browser detected: {detectedTz}
          </p>
        )}
        <datalist id="tz-list">
          {allTimezones.map(tz => (
            <option key={tz} value={tz} />
          ))}
        </datalist>
      </div>
    </div>
  );
}

export default GeneralTab;
