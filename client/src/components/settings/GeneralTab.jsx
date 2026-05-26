import { useState, useEffect, useMemo } from 'react';
import { Save } from 'lucide-react';
import toast from '../ui/Toast';
import BrailleSpinner from '../BrailleSpinner';
import ThemePickerPanel from '../ThemePickerPanel';
import { getSettings, updateSettings } from '../../services/api';

// Coordinate inputs are free text so a partially-typed "-" or "37." isn't
// clobbered mid-edit; parse + range-check only on save. Both blank = clear.
// Trim first so a whitespace-only field counts as blank (and never coerces to
// Number('  ') === 0, which would pin the same 0,0 this feature guards against).
const isBlank = (v) => v == null || String(v).trim() === '';
const parseCoord = (v) => {
  if (isBlank(v)) return null;
  const n = Number(String(v).trim());
  return Number.isFinite(n) ? n : NaN; // NaN signals "non-empty but not a number"
};

export function GeneralTab() {
  const [loading, setLoading] = useState(true);
  const [timezone, setTimezone] = useState('');
  const [saving, setSaving] = useState(false);
  const [lat, setLat] = useState('');
  const [lon, setLon] = useState('');
  const [savingLocation, setSavingLocation] = useState(false);
  const detectedTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const allTimezones = useMemo(() => Intl.supportedValuesOf?.('timeZone') ?? [], []);

  useEffect(() => {
    getSettings({ silent: true })
      .then(settings => {
        setTimezone(settings?.timezone || '');
        setLat(settings?.location?.lat != null ? String(settings.location.lat) : '');
        setLon(settings?.location?.lon != null ? String(settings.location.lon) : '');
      })
      .catch(() => toast.error('Failed to load settings'))
      .finally(() => setLoading(false));
  }, []);

  const handleSaveLocation = async () => {
    // Both-or-neither: weather needs a full pair, and a half-set pair would
    // silently mix a custom value with the tool's default coordinate.
    if (isBlank(lat) !== isBlank(lon)) {
      toast.error('Enter both latitude and longitude, or clear both.');
      return;
    }
    const parsedLat = parseCoord(lat);
    const parsedLon = parseCoord(lon);
    if (Number.isNaN(parsedLat) || Number.isNaN(parsedLon)) {
      toast.error('Latitude and longitude must be numbers.');
      return;
    }
    if (parsedLat !== null && (parsedLat < -90 || parsedLat > 90)) {
      toast.error('Latitude must be between -90 and 90.');
      return;
    }
    if (parsedLon !== null && (parsedLon < -180 || parsedLon > 180)) {
      toast.error('Longitude must be between -180 and 180.');
      return;
    }
    setSavingLocation(true);
    try {
      await updateSettings({ location: { lat: parsedLat, lon: parsedLon } }, { silent: true });
      toast.success(parsedLat === null ? 'Location cleared' : `Location set to ${parsedLat}, ${parsedLon}`);
    } catch (err) {
      toast.error(err.message || 'Failed to save location');
    } finally {
      setSavingLocation(false);
    }
  };

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
      await updateSettings({ timezone: tzToSave }, { silent: true });
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
      <div className="bg-port-card border border-port-border rounded-lg p-4 sm:p-6">
        <h3 className="text-lg font-semibold text-white mb-4">Interface Theme</h3>
        <ThemePickerPanel />
      </div>

      <div className="bg-port-card border border-port-border rounded-lg p-4 sm:p-6">
        <h3 className="text-lg font-semibold text-white mb-4">Timezone</h3>
        <p className="text-sm text-gray-400 mb-4">
          Used for job scheduling (cron expressions & scheduled times) and briefing dates.
        </p>
        <label htmlFor="timezone-input" className="sr-only">Timezone (IANA)</label>
        <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-3">
          <input
            id="timezone-input"
            type="text"
            value={timezone}
            onChange={e => setTimezone(e.target.value)}
            placeholder={detectedTz}
            className="w-full sm:flex-1 sm:max-w-xs min-w-0 px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white text-sm"
            list="tz-list"
          />
          <button
            onClick={() => handleSave(timezone)}
            disabled={saving}
            className="inline-flex items-center justify-center min-h-[40px] px-4 py-2 bg-port-accent/20 hover:bg-port-accent/30 text-port-accent rounded-lg text-sm transition-colors disabled:opacity-50 whitespace-nowrap"
          >
            <Save size={14} className="inline mr-1" />
            {saving ? 'Saving...' : 'Save'}
          </button>
          {!timezone && (
            <button
              onClick={() => handleSave(detectedTz)}
              disabled={saving}
              className="inline-flex items-center justify-center min-h-[40px] px-3 py-2 text-sm text-gray-400 hover:text-white transition-colors truncate"
              title={`Use detected: ${detectedTz}`}
            >
              <span className="truncate">Use detected: {detectedTz}</span>
            </button>
          )}
        </div>
        {timezone && timezone !== detectedTz && (
          <p className="text-xs text-gray-500 mt-2 break-all">
            Browser detected: {detectedTz}
          </p>
        )}
        <datalist id="tz-list">
          {allTimezones.map(tz => (
            <option key={tz} value={tz} />
          ))}
        </datalist>
      </div>

      <div className="bg-port-card border border-port-border rounded-lg p-4 sm:p-6">
        <h3 className="text-lg font-semibold text-white mb-4">Location</h3>
        <p className="text-sm text-gray-400 mb-4">
          Your home coordinates. Used by the voice assistant&apos;s weather command when you
          ask &ldquo;what&apos;s the weather?&rdquo; without naming a place. Leave both blank to use a default location.
        </p>
        <div className="flex flex-col sm:flex-row sm:items-end gap-2 sm:gap-3">
          <div className="flex-1 sm:max-w-[10rem]">
            <label htmlFor="loc-lat" className="block text-xs text-gray-400 mb-1">Latitude (-90 to 90)</label>
            <input
              id="loc-lat"
              type="text"
              inputMode="decimal"
              value={lat}
              onChange={e => setLat(e.target.value)}
              placeholder="37.7749"
              className="w-full min-w-0 px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white text-sm"
            />
          </div>
          <div className="flex-1 sm:max-w-[10rem]">
            <label htmlFor="loc-lon" className="block text-xs text-gray-400 mb-1">Longitude (-180 to 180)</label>
            <input
              id="loc-lon"
              type="text"
              inputMode="decimal"
              value={lon}
              onChange={e => setLon(e.target.value)}
              placeholder="-122.4194"
              className="w-full min-w-0 px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white text-sm"
            />
          </div>
          <button
            onClick={handleSaveLocation}
            disabled={savingLocation}
            className="inline-flex items-center justify-center min-h-[40px] px-4 py-2 bg-port-accent/20 hover:bg-port-accent/30 text-port-accent rounded-lg text-sm transition-colors disabled:opacity-50 whitespace-nowrap"
          >
            <Save size={14} className="inline mr-1" />
            {savingLocation ? 'Saving...' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}

export default GeneralTab;
