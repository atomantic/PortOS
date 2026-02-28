import { useState, useEffect } from 'react';
import { RefreshCw, FileText } from 'lucide-react';
import BrailleSpinner from '../../BrailleSpinner';
import MarkdownOutput from '../../cos/MarkdownOutput';
import * as api from '../../../services/api';

export default function DocumentsTab({ appId, repoPath }) {
  const [documents, setDocuments] = useState([]);
  const [hasPlanning, setHasPlanning] = useState(false);
  const [loading, setLoading] = useState(true);
  const [selectedDoc, setSelectedDoc] = useState(null);
  const [docContent, setDocContent] = useState(null);
  const [loadingDoc, setLoadingDoc] = useState(false);

  const fetchDocuments = async () => {
    setLoading(true);
    const data = await api.getAppDocuments(appId).catch(() => ({ documents: [], hasPlanning: false }));
    setDocuments(data.documents || []);
    setHasPlanning(data.hasPlanning || false);
    setLoading(false);

    // Auto-select first existing document
    const firstExisting = (data.documents || []).find(d => d.exists);
    if (firstExisting && !selectedDoc) {
      loadDocument(firstExisting.filename);
    }
  };

  const loadDocument = async (filename) => {
    setSelectedDoc(filename);
    setLoadingDoc(true);
    const data = await api.getAppDocument(appId, filename).catch(() => null);
    setDocContent(data?.content || null);
    setLoadingDoc(false);
  };

  useEffect(() => {
    fetchDocuments();
  }, [appId]);

  if (loading) {
    return <BrailleSpinner text="Loading documents" />;
  }

  const existingDocs = documents.filter(d => d.exists);
  const missingDocs = documents.filter(d => !d.exists);

  return (
    <div className="max-w-5xl space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-semibold text-white">Documents</h3>
          <p className="text-sm text-gray-500">
            Key project documents from {repoPath ? repoPath.split('/').pop() : 'repo'}
            {hasPlanning && <span className="text-port-accent ml-2">.planning/ exists</span>}
          </p>
        </div>
        <button
          onClick={fetchDocuments}
          className="px-3 py-1.5 bg-port-border hover:bg-port-border/80 text-white rounded-lg text-xs flex items-center gap-1"
        >
          <RefreshCw size={14} /> Refresh
        </button>
      </div>

      {existingDocs.length === 0 ? (
        <div className="bg-port-card border border-port-border rounded-lg p-8 text-center">
          <FileText size={32} className="text-gray-600 mx-auto mb-3" />
          <p className="text-gray-400 mb-2">No documents found</p>
          <p className="text-xs text-gray-500">
            Looking for: {documents.map(d => d.filename).join(', ')}
          </p>
        </div>
      ) : (
        <div className="flex flex-col sm:flex-row gap-4">
          {/* Document selector */}
          <div className="sm:w-48 flex sm:flex-col gap-2">
            {existingDocs.map(doc => (
              <button
                key={doc.filename}
                onClick={() => loadDocument(doc.filename)}
                className={`px-3 py-2 rounded-lg text-sm text-left transition-colors ${
                  selectedDoc === doc.filename
                    ? 'bg-port-accent/20 text-port-accent border border-port-accent/30'
                    : 'bg-port-card border border-port-border text-gray-300 hover:text-white hover:bg-port-border/50'
                }`}
              >
                <FileText size={14} className="inline mr-2" />
                {doc.filename}
              </button>
            ))}
            {missingDocs.length > 0 && (
              <div className="text-xs text-gray-600 mt-2 hidden sm:block">
                Not found: {missingDocs.map(d => d.filename).join(', ')}
              </div>
            )}
          </div>

          {/* Document content */}
          <div className="flex-1 bg-port-card border border-port-border rounded-lg p-4 min-h-[300px] overflow-auto">
            {loadingDoc ? (
              <BrailleSpinner text="Loading document" />
            ) : docContent ? (
              <MarkdownOutput content={docContent} />
            ) : selectedDoc ? (
              <p className="text-gray-500 text-sm">Failed to load document</p>
            ) : (
              <p className="text-gray-500 text-sm">Select a document to view</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
