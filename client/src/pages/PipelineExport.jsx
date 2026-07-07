/**
 * Pipeline — Prose Series Export (#2181).
 *
 * The shipping step for a prose series: configure per-series export settings
 * (trim size, interior font, title-page fields) and download the compiled
 * manuscript (Markdown), an ePub, or a print-interior PDF. Settings persist on
 * the series record via PATCH; the three downloads are plain <a href> links to
 * server routes that stream the artifact (they read the SAVED settings, so the
 * download buttons gate on the form being clean — a dirty form must be saved
 * first, mirroring the "Run Now gates on saved state" rule).
 */

import { useEffect, useMemo, useState } from 'react';
import { Link, useParams, useNavigate } from 'react-router-dom';
import { Loader2, ArrowLeft, Download, Save, BookText, FileText, FileType } from 'lucide-react';
import toast from '../components/ui/Toast';
import {
  getPipelineSeries,
  updatePipelineSeries,
  proseExportManuscriptUrl,
  proseExportEpubUrl,
  proseExportPdfUrl,
} from '../services/api';
import { useAsyncAction } from '../hooks/useAsyncAction';

// Kept in sync with server/lib/proseExportSettings.js (allow-lists + defaults).
const TRIM_SIZE_OPTIONS = [
  { value: 'us-trade', label: 'US Trade (6" × 9")' },
  { value: 'digest', label: 'Digest (5.5" × 8.5")' },
  { value: 'mass-market', label: 'Mass Market (4.25" × 6.75")' },
  { value: 'us-letter', label: 'US Letter (8.5" × 11")' },
  { value: 'a5', label: 'A5' },
];
const FONT_OPTIONS = [
  { value: 'times', label: 'Times (serif)' },
  { value: 'helvetica', label: 'Helvetica (sans)' },
  { value: 'courier', label: 'Courier (mono)' },
];
const DEFAULT_TRIM = 'us-trade';
const DEFAULT_FONT = 'times';

const emptyForm = {
  trimSize: DEFAULT_TRIM,
  interiorFont: DEFAULT_FONT,
  titlePageTitle: '',
  titlePageSubtitle: '',
  titlePageAuthor: '',
  copyright: '',
  dedication: '',
};

// Shape the stored (possibly-null) exportSettings into a fully-populated form,
// filling blank title-page fields from the series so the inputs show the same
// values the export would use.
const formFromSeries = (series) => {
  const es = series?.exportSettings || {};
  return {
    trimSize: es.trimSize || DEFAULT_TRIM,
    interiorFont: es.interiorFont || DEFAULT_FONT,
    titlePageTitle: es.titlePageTitle || series?.name || '',
    titlePageSubtitle: es.titlePageSubtitle || series?.logline || '',
    titlePageAuthor: es.titlePageAuthor || series?.author || '',
    copyright: es.copyright || '',
    dedication: es.dedication || '',
  };
};

export default function PipelineExport() {
  const { seriesId } = useParams();
  const navigate = useNavigate();
  const [series, setSeries] = useState(null);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState(emptyForm);
  const [savedForm, setSavedForm] = useState(emptyForm);

  useEffect(() => {
    let canceled = false;
    setLoading(true);
    getPipelineSeries(seriesId)
      .then((s) => {
        if (canceled) return;
        setSeries(s);
        const f = formFromSeries(s);
        setForm(f);
        setSavedForm(f);
      })
      .catch((err) => {
        if (canceled) return;
        toast.error(err.message || 'Failed to load series');
        navigate('/pipeline');
      })
      .finally(() => { if (!canceled) setLoading(false); });
    return () => { canceled = true; };
  }, [seriesId, navigate]);

  const dirty = useMemo(
    () => JSON.stringify(form) !== JSON.stringify(savedForm),
    [form, savedForm],
  );

  const [saveSettings, saving] = useAsyncAction(async () => {
    const updated = await updatePipelineSeries(seriesId, { exportSettings: form }, { silent: true });
    setSeries(updated);
    setSavedForm(form);
    toast.success('Export settings saved');
  }, { errorMessage: 'Failed to save export settings' });

  const setField = (key) => (e) => setForm((prev) => ({ ...prev, [key]: e.target.value }));

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center text-gray-400">
        <Loader2 className="animate-spin" size={20} />
      </div>
    );
  }

  const downloads = [
    { key: 'md', label: 'Manuscript (.md)', desc: 'Compiled Markdown — front matter, volume breaks, chapter headings.', url: proseExportManuscriptUrl(seriesId), Icon: FileText },
    { key: 'epub', label: 'ePub (.epub)', desc: 'Reflowable e-book — chapters, table of contents, cover.', url: proseExportEpubUrl(seriesId), Icon: BookText },
    { key: 'pdf', label: 'Print Interior (.pdf)', desc: 'Trade-format interior — trim size, running heads, chapter openers.', url: proseExportPdfUrl(seriesId), Icon: FileType },
  ];

  return (
    <div className="h-full overflow-y-auto p-4 md:p-6">
      <header className="flex flex-wrap items-center gap-2 mb-6">
        <Link
          to={`/pipeline/series/${seriesId}`}
          className="inline-flex items-center gap-1 px-2 py-1 rounded text-xs text-gray-400 hover:text-white border border-port-border bg-port-card"
          title="Back to series"
        >
          <ArrowLeft size={12} /> Series
        </Link>
        <h1 className="text-lg font-semibold text-white flex items-center gap-2">
          <Download size={18} className="text-port-accent" /> Export
        </h1>
        {series?.name ? <span className="text-sm text-gray-400 truncate">— {series.name}</span> : null}
      </header>

      <div className="grid gap-6 lg:grid-cols-2 max-w-5xl">
        {/* Settings */}
        <section className="bg-port-card border border-port-border rounded-lg p-4 flex flex-col gap-4">
          <h2 className="text-sm font-semibold text-white">Export settings</h2>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="export-trim" className="block text-xs text-gray-400 mb-1">Trim size</label>
              <select
                id="export-trim"
                value={form.trimSize}
                onChange={setField('trimSize')}
                className="w-full bg-port-bg border border-port-border rounded px-2 py-1.5 text-sm text-white"
              >
                {TRIM_SIZE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </div>
            <div>
              <label htmlFor="export-font" className="block text-xs text-gray-400 mb-1">Interior font</label>
              <select
                id="export-font"
                value={form.interiorFont}
                onChange={setField('interiorFont')}
                className="w-full bg-port-bg border border-port-border rounded px-2 py-1.5 text-sm text-white"
              >
                {FONT_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </div>
          </div>

          <div>
            <label htmlFor="export-title" className="block text-xs text-gray-400 mb-1">Title-page title</label>
            <input
              id="export-title"
              type="text"
              value={form.titlePageTitle}
              onChange={setField('titlePageTitle')}
              placeholder={series?.name || 'Title'}
              className="w-full bg-port-bg border border-port-border rounded px-2 py-1.5 text-sm text-white"
            />
          </div>
          <div>
            <label htmlFor="export-subtitle" className="block text-xs text-gray-400 mb-1">Subtitle</label>
            <input
              id="export-subtitle"
              type="text"
              value={form.titlePageSubtitle}
              onChange={setField('titlePageSubtitle')}
              className="w-full bg-port-bg border border-port-border rounded px-2 py-1.5 text-sm text-white"
            />
          </div>
          <div>
            <label htmlFor="export-author" className="block text-xs text-gray-400 mb-1">Author</label>
            <input
              id="export-author"
              type="text"
              value={form.titlePageAuthor}
              onChange={setField('titlePageAuthor')}
              placeholder={series?.author || 'Author'}
              className="w-full bg-port-bg border border-port-border rounded px-2 py-1.5 text-sm text-white"
            />
          </div>
          <div>
            <label htmlFor="export-copyright" className="block text-xs text-gray-400 mb-1">Copyright line</label>
            <input
              id="export-copyright"
              type="text"
              value={form.copyright}
              onChange={setField('copyright')}
              placeholder="© 2026 …"
              className="w-full bg-port-bg border border-port-border rounded px-2 py-1.5 text-sm text-white"
            />
          </div>
          <div>
            <label htmlFor="export-dedication" className="block text-xs text-gray-400 mb-1">Dedication</label>
            <textarea
              id="export-dedication"
              value={form.dedication}
              onChange={setField('dedication')}
              rows={2}
              className="w-full bg-port-bg border border-port-border rounded px-2 py-1.5 text-sm text-white resize-y"
            />
          </div>

          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={saveSettings}
              disabled={!dirty || saving}
              className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-port-accent text-white text-sm font-medium disabled:opacity-50"
            >
              {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
              {saving ? 'Saving…' : 'Save settings'}
            </button>
            {dirty ? <span className="text-xs text-port-warning">Unsaved changes — save before downloading.</span> : null}
          </div>
        </section>

        {/* Downloads */}
        <section className="bg-port-card border border-port-border rounded-lg p-4 flex flex-col gap-3">
          <h2 className="text-sm font-semibold text-white">Download</h2>
          <p className="text-xs text-gray-500">
            Each export stitches the drafted issue prose in arc order (volume breaks + chapter headings).
            Requires at least one issue with drafted prose.
          </p>
          {downloads.map(({ key, label, desc, url, Icon }) => (
            <a
              key={key}
              href={dirty ? undefined : url}
              download
              aria-disabled={dirty}
              onClick={(e) => { if (dirty) { e.preventDefault(); toast.warning('Save your export settings first'); } }}
              className={`flex items-start gap-3 p-3 rounded-lg border border-port-border bg-port-bg transition ${dirty ? 'opacity-50 cursor-not-allowed' : 'hover:border-port-accent'}`}
            >
              <Icon size={18} className="text-port-accent mt-0.5 shrink-0" />
              <span className="flex flex-col">
                <span className="text-sm text-white font-medium">{label}</span>
                <span className="text-xs text-gray-500">{desc}</span>
              </span>
            </a>
          ))}
        </section>
      </div>
    </div>
  );
}
