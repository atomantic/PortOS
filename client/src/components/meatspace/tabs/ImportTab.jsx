import { useState, useRef, useEffect } from 'react';
import { Upload, FileSpreadsheet, HeartPulse, CheckCircle, AlertCircle } from 'lucide-react';
import * as api from '../../../services/api';
import socket from '../../../services/socket';
import BrailleSpinner from '../../BrailleSpinner';

export default function ImportTab({ onRefresh }) {
  // TSV import state
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [fileName, setFileName] = useState(null);
  const fileInputRef = useRef(null);

  // XML import state
  const [xmlImporting, setXmlImporting] = useState(false);
  const [xmlProgress, setXmlProgress] = useState(0);
  const [xmlResult, setXmlResult] = useState(null);
  const [xmlError, setXmlError] = useState(null);
  const [xmlFileName, setXmlFileName] = useState(null);
  const xmlFileInputRef = useRef(null);

  // WebSocket listeners for XML import progress
  useEffect(() => {
    const onProgress = ({ processed }) => setXmlProgress(processed);
    const onComplete = (data) => {
      setXmlResult(data);
      setXmlImporting(false);
    };
    socket.on('health:xml:progress', onProgress);
    socket.on('health:xml:complete', onComplete);
    return () => {
      socket.off('health:xml:progress', onProgress);
      socket.off('health:xml:complete', onComplete);
    };
  }, []);

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

  const handleXmlFileSelect = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!file.name.endsWith('.xml')) {
      setXmlError('Please select an .xml file. Extract the Apple Health ZIP and upload export.xml.');
      return;
    }

    setXmlFileName(file.name);
    setXmlError(null);
    setXmlResult(null);
    setXmlProgress(0);
    setXmlImporting(true);

    api.uploadAppleHealthXml(file).catch(err => {
      setXmlError(err.message);
      setXmlImporting(false);
    });
    // Success handled via WebSocket health:xml:complete event
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

      {/* Apple Health XML Import */}
      <div className="bg-port-card border border-port-border rounded-xl p-6">
        <div className="flex items-center gap-2 mb-4">
          <HeartPulse size={18} className="text-port-accent" />
          <h3 className="text-sm font-medium text-gray-400 uppercase tracking-wider">
            Apple Health XML Import
          </h3>
        </div>

        <p className="text-sm text-gray-400 mb-2">
          Import your Apple Health export. On your iPhone: Settings &gt; Health &gt; Export All Health Data.
          Extract the ZIP and select the export.xml file.
        </p>
        <p className="text-xs text-gray-500 mb-4">
          Extract the ZIP file first — upload the export.xml file directly.
          Large exports (500MB+) are streamed without loading into memory.
        </p>

        <div className="flex items-center gap-4">
          <input
            ref={xmlFileInputRef}
            type="file"
            accept=".xml"
            onChange={handleXmlFileSelect}
            className="hidden"
          />
          <button
            onClick={() => xmlFileInputRef.current?.click()}
            disabled={xmlImporting}
            className="flex items-center gap-2 px-4 py-2 bg-port-accent text-white rounded-lg hover:bg-port-accent/80 disabled:opacity-50 transition-colors"
          >
            {xmlImporting ? (
              <BrailleSpinner text="Importing" />
            ) : (
              <>
                <Upload size={16} />
                Choose XML File
              </>
            )}
          </button>
          {xmlFileName && !xmlImporting && !xmlResult && (
            <span className="text-sm text-gray-400">{xmlFileName}</span>
          )}
        </div>

        {/* Progress bar (indeterminate — total record count unknown) */}
        {xmlImporting && (
          <div className="mt-4">
            <div className="flex items-center justify-between text-xs text-gray-400 mb-1">
              <span>Processing records...</span>
              <span>{xmlProgress.toLocaleString()} records processed</span>
            </div>
            <div className="h-2 bg-port-border rounded-full overflow-hidden">
              <div className="h-full bg-port-accent rounded-full animate-pulse w-full" />
            </div>
          </div>
        )}

        {/* Success */}
        {xmlResult && (
          <div className="mt-4 p-4 bg-port-success/10 border border-port-success/30 rounded-lg">
            <div className="flex items-center gap-2 mb-2">
              <CheckCircle size={16} className="text-port-success" />
              <span className="text-port-success font-medium">Import successful</span>
            </div>
            <div className="grid grid-cols-2 gap-3 text-sm">
              <div>
                <span className="text-gray-500">Records imported</span>
                <p className="text-white font-semibold">{xmlResult.records?.toLocaleString()}</p>
              </div>
              <div>
                <span className="text-gray-500">Days affected</span>
                <p className="text-white font-semibold">{xmlResult.days?.toLocaleString()}</p>
              </div>
            </div>
          </div>
        )}

        {/* Error */}
        {xmlError && (
          <div className="mt-4 p-4 bg-port-error/10 border border-port-error/30 rounded-lg">
            <div className="flex items-center gap-2">
              <AlertCircle size={16} className="text-port-error" />
              <span className="text-port-error">{xmlError}</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
