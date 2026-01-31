import { useState, useEffect, useRef } from 'react';
import { Folder, FolderOpen, ChevronUp, X, Check } from 'lucide-react';
import * as api from '../services/api';

export default function FolderPicker({ value, onChange }) {
  const [isOpen, setIsOpen] = useState(false);
  const [currentPath, setCurrentPath] = useState('');
  const [parentPath, setParentPath] = useState(null);
  const [directories, setDirectories] = useState([]);
  const [loading, setLoading] = useState(false);
  const modalRef = useRef(null);

  // Load directory contents
  const loadDirectory = async (path = null) => {
    setLoading(true);
    const result = await api.getDirectories(path).catch(() => null);
    if (result) {
      setCurrentPath(result.currentPath);
      setParentPath(result.parentPath);
      setDirectories(result.directories || []);
    }
    setLoading(false);
  };

  // Load initial directory when opened
  useEffect(() => {
    if (isOpen) {
      loadDirectory(value || null);
    }
  }, [isOpen]);

  // Close on click outside
  useEffect(() => {
    const handleClickOutside = (e) => {
      if (modalRef.current && !modalRef.current.contains(e.target)) {
        setIsOpen(false);
      }
    };

    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [isOpen]);

  // Close on Escape
  useEffect(() => {
    const handleEscape = (e) => {
      if (e.key === 'Escape') setIsOpen(false);
    };

    if (isOpen) {
      document.addEventListener('keydown', handleEscape);
      return () => document.removeEventListener('keydown', handleEscape);
    }
  }, [isOpen]);

  const handleSelect = () => {
    onChange(currentPath);
    setIsOpen(false);
  };

  const handleNavigate = (path) => {
    loadDirectory(path);
  };

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setIsOpen(true)}
        className="px-3 py-3 bg-port-border hover:bg-port-border/80 text-white rounded-lg transition-colors"
        title="Browse folders"
      >
        <Folder size={20} />
      </button>

      {isOpen && (
        <div
          className="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
          role="dialog"
          aria-modal="true"
          aria-labelledby="folder-picker-title"
        >
          <div
            ref={modalRef}
            className="bg-port-card border border-port-border rounded-xl w-full max-w-lg max-h-[80vh] flex flex-col shadow-2xl"
          >
            {/* Header */}
            <div className="flex items-center justify-between p-4 border-b border-port-border">
              <h3 id="folder-picker-title" className="text-lg font-semibold text-white">Select Folder</h3>
              <button
                type="button"
                onClick={() => setIsOpen(false)}
                className="p-1 text-gray-400 hover:text-white"
              >
                <X size={20} />
              </button>
            </div>

            {/* Current Path */}
            <div className="px-4 py-2 bg-port-bg border-b border-port-border">
              <p className="text-sm font-mono text-gray-400 truncate" title={currentPath}>
                {currentPath}
              </p>
            </div>

            {/* Directory List */}
            <div className="flex-1 overflow-auto p-2 min-h-[300px]">
              {loading ? (
                <div className="flex items-center justify-center h-full text-gray-500">
                  Loading...
                </div>
              ) : (
                <div className="space-y-1">
                  {/* Go Up */}
                  {parentPath && (
                    <button
                      type="button"
                      onClick={() => handleNavigate(parentPath)}
                      className="w-full flex items-center gap-3 px-3 py-2 text-left rounded-lg hover:bg-port-border/50 text-gray-400 hover:text-white transition-colors"
                    >
                      <ChevronUp size={18} />
                      <span>..</span>
                    </button>
                  )}

                  {/* Directories */}
                  {directories.map((dir) => (
                    <button
                      key={dir.path}
                      type="button"
                      onClick={() => handleNavigate(dir.path)}
                      className="w-full flex items-center gap-3 px-3 py-2 text-left rounded-lg hover:bg-port-border/50 text-white transition-colors"
                    >
                      <FolderOpen size={18} className="text-port-accent shrink-0" />
                      <span className="truncate">{dir.name}</span>
                    </button>
                  ))}

                  {directories.length === 0 && !parentPath && (
                    <div className="text-center text-gray-500 py-8">
                      No subdirectories
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Footer */}
            <div className="flex items-center justify-between gap-3 p-4 border-t border-port-border">
              <button
                type="button"
                onClick={() => setIsOpen(false)}
                className="px-4 py-2 text-gray-400 hover:text-white transition-colors"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleSelect}
                className="flex items-center gap-2 px-4 py-2 bg-port-accent hover:bg-port-accent/80 text-white rounded-lg transition-colors"
              >
                <Check size={18} />
                Select This Folder
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
