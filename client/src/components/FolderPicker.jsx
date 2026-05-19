import { useState, useEffect, useRef, useCallback } from 'react';
import { Folder, FolderOpen, ChevronUp, HardDrive, Home, X, Check, AlertCircle } from 'lucide-react';
import * as api from '../services/api';

export default function FolderPicker({ value, onChange, defaultPath }) {
  const [isOpen, setIsOpen] = useState(false);
  const [currentPath, setCurrentPath] = useState('');
  const [parentPath, setParentPath] = useState(null);
  const [directories, setDirectories] = useState([]);
  const [drives, setDrives] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const modalRef = useRef(null);
  // Remember when `defaultPath` has already failed once so re-opens skip the
  // wasted round trip (and the server-side 400 it logs). Ref-not-state because
  // changing it must not re-trigger the open effect.
  const defaultPathUnavailableRef = useRef(false);

  // Load directory contents. When fallbackToDefault is true and the requested
  // path fails BECAUSE IT DOESN'T EXIST (e.g. iCloud Obsidian folder absent),
  // silently retry with the server's default so the picker still opens
  // somewhere usable. Other failures (server down, permission denied,
  // transient 5xx) propagate as errors and do NOT poison the
  // defaultPathUnavailable cache — otherwise a one-time network blip would
  // permanently disable the default for the rest of the session.
  const loadDirectory = useCallback(async (path = null, { fallbackToDefault = false } = {}) => {
    // Local helper so it stays inside the useCallback closure — keeps
    // react-hooks/exhaustive-deps quiet and rules out stale-closure surprises
    // if it ever starts reading state/props in the future.
    const isPathAbsentError = (err) => (
      err?.status === 400 && (err.code === 'INVALID_PATH' || err.code === 'NOT_A_DIRECTORY')
    );
    setLoading(true);
    setError(null);
    const applyResult = (result) => {
      setCurrentPath(result.currentPath);
      setParentPath(result.parentPath);
      setDirectories(result.directories || []);
      setDrives(result.drives ?? null);
    };
    let lastError = null;
    let result = await api.getDirectories(path).catch((err) => {
      lastError = err;
      return null;
    });
    if (!result && fallbackToDefault && path != null && isPathAbsentError(lastError)) {
      defaultPathUnavailableRef.current = true;
      lastError = null;
      result = await api.getDirectories(null).catch((err) => {
        lastError = err;
        return null;
      });
    }
    if (result) {
      applyResult(result);
    } else if (lastError) {
      setError(lastError.message || 'Failed to load directory');
    }
    setLoading(false);
  }, []);

  // Load initial directory when opened
  useEffect(() => {
    if (isOpen) {
      const useDefault = !value && !!defaultPath && !defaultPathUnavailableRef.current;
      const initialPath = value || (useDefault ? defaultPath : null);
      loadDirectory(initialPath, { fallbackToDefault: useDefault });
    }
  }, [isOpen, loadDirectory, value, defaultPath]);

  // Reset the "default unavailable" cache when the caller changes which
  // defaultPath to try — a different path is worth probing again.
  useEffect(() => {
    defaultPathUnavailableRef.current = false;
  }, [defaultPath]);

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
        aria-label="Browse folders"
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
                aria-label="Close folder picker"
              >
                <X size={20} />
              </button>
            </div>

            {/* Current Path + Quick Nav */}
            <div className="px-4 py-2 bg-port-bg border-b border-port-border flex items-center gap-2">
              <p className="flex-1 text-sm font-mono text-gray-400 truncate" title={currentPath}>
                {currentPath}
              </p>
              {/* Home directory button */}
              <button
                type="button"
                onClick={() => handleNavigate('~')}
                className="p-1 text-gray-500 hover:text-white shrink-0"
                title="Home directory"
              >
                <Home size={16} />
              </button>
            </div>

            {/* Windows Drive Selector */}
            {drives && drives.length > 0 && (
              <div className="px-4 py-2 border-b border-port-border flex items-center gap-1 flex-wrap">
                <HardDrive size={14} className="text-gray-500 shrink-0 mr-1" />
                {drives.map((drive) => (
                  <button
                    key={drive}
                    type="button"
                    onClick={() => handleNavigate(drive)}
                    className={`px-2 py-0.5 text-xs font-mono rounded transition-colors ${
                      currentPath.toUpperCase().startsWith(drive.charAt(0).toUpperCase())
                        ? 'bg-port-accent text-white'
                        : 'bg-port-border text-gray-400 hover:text-white hover:bg-port-border/80'
                    }`}
                  >
                    {drive.charAt(0)}:
                  </button>
                ))}
              </div>
            )}

            {/* Directory List */}
            <div className="flex-1 overflow-auto p-2 min-h-[300px]">
              {loading ? (
                <div className="flex items-center justify-center h-full text-gray-500">
                  Loading...
                </div>
              ) : error ? (
                <div className="flex flex-col items-center justify-center h-full gap-2 text-gray-500 px-4">
                  <AlertCircle size={24} className="text-port-error" />
                  <p className="text-sm text-center">{error}</p>
                  <button
                    type="button"
                    onClick={() => loadDirectory(null)}
                    className="mt-2 text-xs text-port-accent hover:underline"
                  >
                    Go to default directory
                  </button>
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
                disabled={!currentPath || loading || !!error}
                className="flex items-center gap-2 px-4 py-2 bg-port-accent hover:bg-port-accent/80 text-white rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
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
