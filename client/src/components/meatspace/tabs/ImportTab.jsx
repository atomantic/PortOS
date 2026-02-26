import { useState, useRef } from 'react';
import { Upload, FileSpreadsheet, CheckCircle, AlertCircle } from 'lucide-react';
import * as api from '../../../services/api';
import BrailleSpinner from '../../BrailleSpinner';

export default function ImportTab({ onRefresh }) {
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [fileName, setFileName] = useState(null);
  const fileInputRef = useRef(null);

  const handleFileSelect = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setFileName(file.name);
    setError(null);
    setResult(null);
    setImporting(true);

    const reader = new FileReader();
    reader.onload = async (event) => {
      const content = event.target.result;
      const stats = await api.importMeatspaceTSV(content).catch(err => {
        setError(err.message);
        return null;
      });

      if (stats) {
        setResult(stats);
        onRefresh?.();
      }
      setImporting(false);
    };
    reader.onerror = () => {
      setError('Failed to read file');
      setImporting(false);
    };
    reader.readAsText(file);
  };

  return (
    <div className="space-y-6">
      {/* TSV Import */}
      <div className="bg-port-card border border-port-border rounded-xl p-6">
        <div className="flex items-center gap-2 mb-4">
          <FileSpreadsheet size={18} className="text-port-accent" />
          <h3 className="text-sm font-medium text-gray-400 uppercase tracking-wider">
            Health Spreadsheet Import (TSV)
          </h3>
        </div>

        <p className="text-sm text-gray-400 mb-4">
          Import your health tracking spreadsheet. Expects a TSV file with 3 header rows,
          2 summary rows, then daily data. Covers alcohol, body composition,
          blood tests, epigenetic results, and eye prescriptions.
        </p>
        <p className="text-xs text-gray-500 mb-4">
          Import is idempotent — re-importing replaces all existing data.
        </p>

        <div className="flex items-center gap-4">
          <input
            ref={fileInputRef}
            type="file"
            accept=".tsv,.txt,.csv"
            onChange={handleFileSelect}
            className="hidden"
          />
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={importing}
            className="flex items-center gap-2 px-4 py-2 bg-port-accent text-white rounded-lg hover:bg-port-accent/80 disabled:opacity-50 transition-colors"
          >
            {importing ? (
              <BrailleSpinner text="Importing" />
            ) : (
              <>
                <Upload size={16} />
                Choose TSV File
              </>
            )}
          </button>
          {fileName && !importing && (
            <span className="text-sm text-gray-400">{fileName}</span>
          )}
        </div>

        {/* Success */}
        {result && (
          <div className="mt-4 p-4 bg-port-success/10 border border-port-success/30 rounded-lg">
            <div className="flex items-center gap-2 mb-2">
              <CheckCircle size={16} className="text-port-success" />
              <span className="text-port-success font-medium">Import successful</span>
            </div>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
              <div>
                <span className="text-gray-500">Daily entries</span>
                <p className="text-white font-semibold">{result.dailyEntries}</p>
              </div>
              <div>
                <span className="text-gray-500">Blood tests</span>
                <p className="text-white font-semibold">{result.bloodTests}</p>
              </div>
              <div>
                <span className="text-gray-500">Epigenetic tests</span>
                <p className="text-white font-semibold">{result.epigeneticTests}</p>
              </div>
              <div>
                <span className="text-gray-500">Eye exams</span>
                <p className="text-white font-semibold">{result.eyeExams}</p>
              </div>
            </div>
            {result.dateRange && (
              <p className="text-xs text-gray-400 mt-2">
                Date range: {result.dateRange.from} to {result.dateRange.to}
              </p>
            )}
          </div>
        )}

        {/* Error */}
        {error && (
          <div className="mt-4 p-4 bg-port-error/10 border border-port-error/30 rounded-lg">
            <div className="flex items-center gap-2">
              <AlertCircle size={16} className="text-port-error" />
              <span className="text-port-error">{error}</span>
            </div>
          </div>
        )}
      </div>

      {/* Apple Health Placeholder */}
      <div className="bg-port-card border border-port-border rounded-xl p-6 opacity-60">
        <div className="flex items-center gap-2 mb-2">
          <Upload size={18} className="text-gray-500" />
          <h3 className="text-sm font-medium text-gray-500 uppercase tracking-wider">
            Apple Health Import
          </h3>
        </div>
        <p className="text-sm text-gray-500">Coming soon — import from Apple Health XML export.</p>
      </div>
    </div>
  );
}
