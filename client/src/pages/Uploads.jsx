import { useState, useEffect, useCallback, useRef } from 'react';
import { Upload, Trash2, Download, FileText, Image, File, FolderOpen, RefreshCw } from 'lucide-react';
import toast from 'react-hot-toast';
import * as api from '../services/api';

// File type icons based on MIME type
function getFileIcon(mimeType) {
  if (mimeType?.startsWith('image/')) return <Image size={20} className="text-purple-400" />;
  if (mimeType?.startsWith('text/') || mimeType?.includes('json') || mimeType?.includes('xml')) {
    return <FileText size={20} className="text-blue-400" />;
  }
  return <File size={20} className="text-gray-400" />;
}

// Check if file is previewable as image
function isPreviewableImage(mimeType) {
  return mimeType?.startsWith('image/') && !mimeType?.includes('svg');
}

export default function Uploads() {
  const [uploads, setUploads] = useState([]);
  const [stats, setStats] = useState({ count: 0, totalSizeFormatted: '0 B' });
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const fileInputRef = useRef(null);

  const fetchUploads = useCallback(async () => {
    const data = await api.listUploads().catch(err => {
      toast.error(err.message);
      return { uploads: [], count: 0, totalSizeFormatted: '0 B' };
    });
    setUploads(data.uploads || []);
    setStats({ count: data.count || 0, totalSizeFormatted: data.totalSizeFormatted || '0 B' });
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchUploads();
  }, [fetchUploads]);

  const handleFileUpload = async (files) => {
    if (!files || files.length === 0) return;

    setUploading(true);
    const fileArray = Array.from(files);

    for (const file of fileArray) {
      // Check file size (100MB limit)
      if (file.size > 100 * 1024 * 1024) {
        toast.error(`File "${file.name}" exceeds 100MB limit`);
        continue;
      }

      // Read file as base64
      const base64 = await new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = (e) => {
          const result = e.target?.result;
          if (typeof result === 'string') {
            resolve(result.split(',')[1]);
          } else {
            resolve(null);
          }
        };
        reader.onerror = () => resolve(null);
        reader.readAsDataURL(file);
      });

      if (!base64) {
        toast.error(`Failed to read file "${file.name}"`);
        continue;
      }

      const result = await api.uploadFile(base64, file.name).catch(err => {
        toast.error(`Failed to upload "${file.name}": ${err.message}`);
        return null;
      });

      if (result) {
        toast.success(`Uploaded "${file.name}"`);
      }
    }

    setUploading(false);
    fetchUploads();
  };

  const handleDelete = async (filename) => {
    const result = await api.deleteUpload(filename).catch(err => {
      toast.error(err.message);
      return null;
    });

    if (result?.success) {
      toast.success('File deleted');
      fetchUploads();
    }
  };

  const handleDeleteAll = async () => {
    if (uploads.length === 0) {
      toast.error('No files to delete');
      return;
    }

    const result = await api.deleteAllUploads().catch(err => {
      toast.error(err.message);
      return null;
    });

    if (result?.success) {
      toast.success(`Deleted ${result.deleted} files (${result.freedSpaceFormatted})`);
      fetchUploads();
    }
  };

  const handleDrag = (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === 'dragenter' || e.type === 'dragover') {
      setDragActive(true);
    } else if (e.type === 'dragleave') {
      setDragActive(false);
    }
  };

  const handleDrop = (e) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      handleFileUpload(e.dataTransfer.files);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-gray-500">Loading...</div>
      </div>
    );
  }

  return (
    <div>
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 sm:gap-4 mb-6">
        <div>
          <h2 className="text-2xl font-bold text-white">File Uploads</h2>
          <p className="text-gray-500 text-sm sm:text-base">
            {stats.count} file{stats.count !== 1 ? 's' : ''} ({stats.totalSizeFormatted})
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={fetchUploads}
            className="flex items-center gap-2 px-3 py-2 bg-port-card border border-port-border rounded-lg text-gray-400 hover:text-white hover:border-port-accent/50 transition-colors"
            title="Refresh"
          >
            <RefreshCw size={16} />
          </button>
          {uploads.length > 0 && (
            <button
              onClick={handleDeleteAll}
              className="flex items-center gap-2 px-3 py-2 bg-port-error/20 border border-port-error/50 rounded-lg text-port-error hover:bg-port-error/30 transition-colors"
            >
              <Trash2 size={16} />
              Delete All
            </button>
          )}
        </div>
      </div>

      {/* Upload Zone */}
      <div
        className={`relative mb-6 p-8 border-2 border-dashed rounded-lg text-center transition-colors ${
          dragActive
            ? 'border-port-accent bg-port-accent/10'
            : 'border-port-border hover:border-port-accent/50 bg-port-card'
        }`}
        onDragEnter={handleDrag}
        onDragLeave={handleDrag}
        onDragOver={handleDrag}
        onDrop={handleDrop}
      >
        <input
          ref={fileInputRef}
          type="file"
          multiple
          onChange={(e) => handleFileUpload(e.target.files)}
          className="hidden"
        />

        <Upload size={40} className={`mx-auto mb-4 ${dragActive ? 'text-port-accent' : 'text-gray-500'}`} />

        <p className="text-white mb-2">
          {dragActive ? 'Drop files here' : 'Drag and drop files here'}
        </p>
        <p className="text-gray-500 text-sm mb-4">or</p>
        <button
          onClick={() => fileInputRef.current?.click()}
          disabled={uploading}
          className="px-4 py-2 bg-port-accent/20 hover:bg-port-accent/30 text-port-accent rounded-lg transition-colors disabled:opacity-50"
        >
          {uploading ? 'Uploading...' : 'Browse Files'}
        </button>
        <p className="text-gray-500 text-xs mt-4">
          Maximum file size: 100MB
        </p>
      </div>

      {/* Files List */}
      {uploads.length === 0 ? (
        <div className="bg-port-card border border-port-border rounded-lg p-8 text-center">
          <FolderOpen size={48} className="mx-auto mb-4 text-gray-500" />
          <p className="text-gray-500">No files uploaded yet</p>
          <p className="text-gray-600 text-sm mt-1">Upload files using the drop zone above</p>
        </div>
      ) : (
        <div className="bg-port-card border border-port-border rounded-lg overflow-hidden">
          <div className="grid grid-cols-1 divide-y divide-port-border">
            {uploads.map((file) => (
              <div
                key={file.filename}
                className="flex items-center gap-4 p-4 hover:bg-port-bg/50 transition-colors group"
              >
                {/* Icon or Preview */}
                <div className="w-12 h-12 flex items-center justify-center bg-port-bg rounded-lg shrink-0">
                  {isPreviewableImage(file.mimeType) ? (
                    <img
                      src={api.getUploadUrl(file.filename)}
                      alt={file.filename}
                      className="w-12 h-12 object-cover rounded-lg"
                    />
                  ) : (
                    getFileIcon(file.mimeType)
                  )}
                </div>

                {/* File Info */}
                <div className="flex-1 min-w-0">
                  <p className="text-white font-medium truncate" title={file.filename}>
                    {file.filename}
                  </p>
                  <p className="text-gray-500 text-sm">
                    {file.sizeFormatted} &middot; {file.mimeType}
                  </p>
                  <p className="text-gray-600 text-xs">
                    Uploaded {new Date(file.createdAt).toLocaleString()}
                  </p>
                </div>

                {/* Actions */}
                <div className="flex items-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                  <a
                    href={api.getUploadUrl(file.filename)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="p-2 text-gray-500 hover:text-port-accent transition-colors"
                    title="Download / View"
                  >
                    <Download size={18} />
                  </a>
                  <button
                    onClick={() => handleDelete(file.filename)}
                    className="p-2 text-gray-500 hover:text-port-error transition-colors"
                    title="Delete"
                  >
                    <Trash2 size={18} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
