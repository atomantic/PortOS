import { useState, useEffect } from 'react';
import {
  Download,
  Copy,
  Check,
  FileText,
  Code,
  FileJson,
  Files,
  RefreshCw,
  Eye
} from 'lucide-react';
import * as api from '../../../services/api';
import toast from 'react-hot-toast';

import { EXPORT_FORMATS, DOCUMENT_CATEGORIES } from '../constants';

export default function ExportTab({ onRefresh }) {
  const [documents, setDocuments] = useState([]);
  const [formats, setFormats] = useState([]);
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);

  // Export configuration
  const [selectedFormat, setSelectedFormat] = useState('system_prompt');
  const [selectedDocs, setSelectedDocs] = useState([]);
  const [includeDisabled, setIncludeDisabled] = useState(false);

  // Export result
  const [exportResult, setExportResult] = useState(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    setLoading(true);
    const [docsData, formatsData] = await Promise.all([
      api.getSoulDocuments().catch(() => []),
      api.getSoulExportFormats().catch(() => [])
    ]);
    setDocuments(docsData);
    setFormats(formatsData);

    // Default: select all enabled documents
    setSelectedDocs(docsData.filter(d => d.enabled).map(d => d.id));

    setLoading(false);
  };

  const toggleDocument = (docId) => {
    setSelectedDocs(prev =>
      prev.includes(docId) ? prev.filter(id => id !== docId) : [...prev, docId]
    );
  };

  const handleExport = async () => {
    setExporting(true);
    const result = await api.exportSoul(
      selectedFormat,
      selectedDocs.length > 0 ? selectedDocs : null,
      includeDisabled
    );
    setExportResult(result);
    setExporting(false);
  };

  const copyToClipboard = async () => {
    if (!exportResult) return;

    const content = typeof exportResult.content === 'string'
      ? exportResult.content
      : JSON.stringify(exportResult.content, null, 2);

    await navigator.clipboard.writeText(content);
    setCopied(true);
    toast.success('Copied to clipboard');
    setTimeout(() => setCopied(false), 2000);
  };

  const downloadFile = () => {
    if (!exportResult) return;

    const content = typeof exportResult.content === 'string'
      ? exportResult.content
      : JSON.stringify(exportResult.content, null, 2);

    const extension = selectedFormat === 'json' ? 'json' : 'md';
    const filename = `soul-export.${extension}`;

    const blob = new Blob([content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    toast.success(`Downloaded ${filename}`);
  };

  const getFormatIcon = (formatId) => {
    switch (formatId) {
      case 'system_prompt':
        return FileText;
      case 'claude_md':
        return Code;
      case 'json':
        return FileJson;
      case 'individual':
        return Files;
      default:
        return FileText;
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <RefreshCw className="w-8 h-8 text-port-accent animate-spin" />
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
      {/* Configuration */}
      <div className="space-y-6">
        {/* Format Selection */}
        <div className="bg-port-card rounded-lg border border-port-border p-4">
          <h3 className="font-semibold text-white mb-4">Export Format</h3>
          <div className="space-y-2">
            {formats.map(format => {
              const Icon = getFormatIcon(format.id);
              return (
                <button
                  key={format.id}
                  onClick={() => {
                    setSelectedFormat(format.id);
                    setExportResult(null);
                  }}
                  className={`w-full flex items-start gap-3 p-3 rounded-lg border transition-colors text-left ${
                    selectedFormat === format.id
                      ? 'border-port-accent bg-port-accent/10'
                      : 'border-port-border hover:border-gray-500'
                  }`}
                >
                  <Icon className={`w-5 h-5 mt-0.5 ${
                    selectedFormat === format.id ? 'text-port-accent' : 'text-gray-400'
                  }`} />
                  <div>
                    <div className={`font-medium ${
                      selectedFormat === format.id ? 'text-port-accent' : 'text-white'
                    }`}>
                      {format.label}
                    </div>
                    <div className="text-sm text-gray-400">{format.description}</div>
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        {/* Document Selection */}
        <div className="bg-port-card rounded-lg border border-port-border p-4">
          <div className="flex items-center justify-between mb-4">
            <h3 className="font-semibold text-white">Documents ({selectedDocs.length})</h3>
            <div className="flex gap-2">
              <button
                onClick={() => setSelectedDocs(documents.map(d => d.id))}
                className="text-xs text-port-accent hover:text-white"
              >
                All
              </button>
              <button
                onClick={() => setSelectedDocs(documents.filter(d => d.enabled).map(d => d.id))}
                className="text-xs text-gray-500 hover:text-white"
              >
                Enabled
              </button>
              <button
                onClick={() => setSelectedDocs([])}
                className="text-xs text-gray-500 hover:text-white"
              >
                None
              </button>
            </div>
          </div>

          <div className="space-y-2 max-h-64 overflow-y-auto">
            {documents.map(doc => (
              <label
                key={doc.id}
                className="flex items-center gap-3 p-2 rounded hover:bg-port-border cursor-pointer"
              >
                <input
                  type="checkbox"
                  checked={selectedDocs.includes(doc.id)}
                  onChange={() => toggleDocument(doc.id)}
                  className="w-4 h-4 rounded border-port-border bg-port-bg text-port-accent focus:ring-port-accent"
                />
                <div className="flex-1 min-w-0">
                  <div className={`text-sm truncate ${doc.enabled ? 'text-white' : 'text-gray-500'}`}>
                    {doc.title}
                  </div>
                  <div className="text-xs text-gray-500">
                    {DOCUMENT_CATEGORIES[doc.category]?.label}
                    {!doc.enabled && ' • Disabled'}
                  </div>
                </div>
              </label>
            ))}
          </div>

          <label className="flex items-center gap-2 mt-4 pt-4 border-t border-port-border">
            <input
              type="checkbox"
              checked={includeDisabled}
              onChange={(e) => setIncludeDisabled(e.target.checked)}
              className="w-4 h-4 rounded border-port-border bg-port-bg text-port-accent focus:ring-port-accent"
            />
            <span className="text-sm text-gray-400">Include disabled documents</span>
          </label>
        </div>

        {/* Export Button */}
        <button
          onClick={handleExport}
          disabled={exporting || selectedDocs.length === 0}
          className="w-full flex items-center justify-center gap-2 px-6 py-3 bg-port-accent text-white rounded-lg font-medium hover:bg-port-accent/80 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {exporting ? (
            <>
              <RefreshCw className="w-5 h-5 animate-spin" />
              Exporting...
            </>
          ) : (
            <>
              <Download className="w-5 h-5" />
              Generate Export
            </>
          )}
        </button>
      </div>

      {/* Preview / Result */}
      <div className="bg-port-card rounded-lg border border-port-border overflow-hidden flex flex-col">
        <div className="p-4 border-b border-port-border flex items-center justify-between">
          <h3 className="font-semibold text-white flex items-center gap-2">
            <Eye size={18} />
            Preview
          </h3>

          {exportResult && (
            <div className="flex items-center gap-2">
              <span className="text-sm text-gray-500">
                ~{exportResult.tokenEstimate?.toLocaleString()} tokens
              </span>
              <button
                onClick={copyToClipboard}
                className="p-1.5 text-gray-400 hover:text-white transition-colors"
                title="Copy to clipboard"
              >
                {copied ? <Check size={18} className="text-green-400" /> : <Copy size={18} />}
              </button>
              <button
                onClick={downloadFile}
                className="p-1.5 text-gray-400 hover:text-white transition-colors"
                title="Download"
              >
                <Download size={18} />
              </button>
            </div>
          )}
        </div>

        <div className="flex-1 overflow-auto p-4">
          {exportResult ? (
            <pre className="text-sm text-gray-300 whitespace-pre-wrap font-mono">
              {typeof exportResult.content === 'string'
                ? exportResult.content
                : JSON.stringify(exportResult.content, null, 2)}
            </pre>
          ) : (
            <div className="flex items-center justify-center h-full text-gray-500">
              <div className="text-center">
                <Download className="w-12 h-12 mx-auto mb-4 opacity-50" />
                <p>Select options and generate export</p>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Usage Instructions */}
      {exportResult && (
        <div className="lg:col-span-2 bg-port-card rounded-lg border border-port-border p-4">
          <h3 className="font-semibold text-white mb-3">How to Use</h3>

          {selectedFormat === 'system_prompt' && (
            <div className="text-sm text-gray-400 space-y-2">
              <p>1. Copy the exported content</p>
              <p>2. Paste into your LLMs system prompt / custom instructions</p>
              <p>3. The LLM will now respond according to your soul document</p>
            </div>
          )}

          {selectedFormat === 'claude_md' && (
            <div className="text-sm text-gray-400 space-y-2">
              <p>1. Download or copy the export</p>
              <p>2. Add to your project as <code className="bg-port-bg px-1 rounded">CLAUDE.md</code></p>
              <p>3. Claude Code will automatically read and apply these instructions</p>
            </div>
          )}

          {selectedFormat === 'json' && (
            <div className="text-sm text-gray-400 space-y-2">
              <p>1. Download the JSON export</p>
              <p>2. Parse and inject into your API requests</p>
              <p>3. Use the documents array to build system prompts programmatically</p>
            </div>
          )}

          {selectedFormat === 'individual' && (
            <div className="text-sm text-gray-400 space-y-2">
              <p>1. Each document is exported separately</p>
              <p>2. Use individual files for selective context injection</p>
              <p>3. Combine as needed for different use cases</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
