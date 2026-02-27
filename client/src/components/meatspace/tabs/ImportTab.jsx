import { useState, useRef, useEffect } from 'react';
import { Upload, FileJson, HeartPulse, CheckCircle, AlertCircle } from 'lucide-react';
import * as api from '../../../services/api';
import socket from '../../../services/socket';
import BrailleSpinner from '../../BrailleSpinner';

export default function ImportTab({ onRefresh }) {
  // JSON import state
  const [jsonImporting, setJsonImporting] = useState(false);
  const [jsonResult, setJsonResult] = useState(null);
  const [jsonError, setJsonError] = useState(null);
  const [jsonFileName, setJsonFileName] = useState(null);
  const jsonFileInputRef = useRef(null);

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

  const handleJsonFileSelect = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!file.name.endsWith('.json')) {
      setJsonError('Please select a .json file exported from Health Auto Export or similar app.');
      return;
    }

    setJsonFileName(file.name);
    setJsonError(null);
    setJsonResult(null);
    setJsonImporting(true);

    const reader = new FileReader();
    reader.onload = async (event) => {
      let parsed;
      try {
        parsed = JSON.parse(event.target.result);
      } catch {
        setJsonError('Invalid JSON file — could not parse contents.');
        setJsonImporting(false);
        return;
      }

      const stats = await api.ingestAppleHealth(parsed).catch(err => {
        setJsonError(err.message);
        return null;
      });

      if (stats) {
        setJsonResult(stats);
        onRefresh?.();
      }
      setJsonImporting(false);
    };
    reader.onerror = () => {
      setJsonError('Failed to read file');
      setJsonImporting(false);
    };
    reader.readAsText(file);
  };

  const handleXmlFileSelect = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!file.name.endsWith('.xml') && !file.name.endsWith('.zip')) {
      setXmlError('Please select an .xml or .zip file from your Apple Health export.');
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
      {/* Health Auto Export JSON Import */}
      <div className="bg-port-card border border-port-border rounded-xl p-6">
        <div className="flex items-center gap-2 mb-4">
          <FileJson size={18} className="text-port-accent" />
          <h3 className="text-sm font-medium text-gray-400 uppercase tracking-wider">
            Health Auto Export JSON Import
          </h3>
        </div>

        <p className="text-sm text-gray-400 mb-2">
          Import JSON files from Health Auto Export or similar apps that export Apple Health data as JSON.
        </p>
        <p className="text-xs text-gray-500 mb-4">
          Duplicate records are automatically skipped — safe to re-import the same file.
        </p>

        <div className="flex items-center gap-4">
          <input
            ref={jsonFileInputRef}
            type="file"
            accept=".json"
            onChange={handleJsonFileSelect}
            className="hidden"
          />
          <button
            onClick={() => jsonFileInputRef.current?.click()}
            disabled={jsonImporting}
            className="flex items-center gap-2 px-4 py-2 bg-port-accent text-white rounded-lg hover:bg-port-accent/80 disabled:opacity-50 transition-colors"
          >
            {jsonImporting ? (
              <BrailleSpinner text="Importing" />
            ) : (
              <>
                <Upload size={16} />
                Choose JSON File
              </>
            )}
          </button>
          {jsonFileName && !jsonImporting && !jsonResult && (
            <span className="text-sm text-gray-400">{jsonFileName}</span>
          )}
        </div>

        {/* Success */}
        {jsonResult && (
          <div className="mt-4 p-4 bg-port-success/10 border border-port-success/30 rounded-lg">
            <div className="flex items-center gap-2 mb-2">
              <CheckCircle size={16} className="text-port-success" />
              <span className="text-port-success font-medium">Import successful</span>
            </div>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
              <div>
                <span className="text-gray-500">Metrics processed</span>
                <p className="text-white font-semibold">{jsonResult.metricsProcessed?.toLocaleString()}</p>
              </div>
              <div>
                <span className="text-gray-500">Records ingested</span>
                <p className="text-white font-semibold">{jsonResult.recordsIngested?.toLocaleString()}</p>
              </div>
              <div>
                <span className="text-gray-500">Records skipped</span>
                <p className="text-white font-semibold">{jsonResult.recordsSkipped?.toLocaleString()}</p>
              </div>
              <div>
                <span className="text-gray-500">Days affected</span>
                <p className="text-white font-semibold">{jsonResult.daysAffected?.toLocaleString()}</p>
              </div>
            </div>
          </div>
        )}

        {/* Error */}
        {jsonError && (
          <div className="mt-4 p-4 bg-port-error/10 border border-port-error/30 rounded-lg">
            <div className="flex items-center gap-2">
              <AlertCircle size={16} className="text-port-error" />
              <span className="text-port-error">{jsonError}</span>
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
          Import your Apple Health export. On your iPhone: open the <strong className="text-gray-300">Health</strong> app,
          tap your <strong className="text-gray-300">profile icon</strong> (top right),
          scroll down and tap <strong className="text-gray-300">Export All Health Data</strong>.
          Upload the ZIP directly or extract it and select export.xml.
        </p>
        <p className="text-xs text-gray-500 mb-4">
          You can upload the ZIP file as-is — the server will extract export.xml automatically.
          Large exports (500MB+) are streamed without loading into memory.
        </p>

        <div className="flex items-center gap-4">
          <input
            ref={xmlFileInputRef}
            type="file"
            accept=".xml,.zip"
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
                Choose XML or ZIP File
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
