import { useState, useEffect } from 'react';
import { Folder, ChevronRight, Home, ArrowUp, Loader2 } from 'lucide-react';
import * as api from '../services/api';

export default function DirectoryPicker({ value, onChange, label = 'Select Directory' }) {
  const [currentPath, setCurrentPath] = useState('');
  const [parentPath, setParentPath] = useState(null);
  const [directories, setDirectories] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [isOpen, setIsOpen] = useState(false);

  useEffect(() => {
    // Load directories and auto-set value if none provided
    loadDirectories(value || null, !value);
  }, []);

  const loadDirectories = async (path = null, setAsValue = false) => {
    setLoading(true);
    setError(null);

    const result = await api.getDirectories(path).catch(err => {
      setError(err.message);
      return null;
    });

    if (result) {
      setCurrentPath(result.currentPath);
      setParentPath(result.parentPath);
      setDirectories(result.directories);
      // Auto-set the value if requested (e.g., on initial load with no value)
      if (setAsValue && result.currentPath) {
        onChange(result.currentPath);
      }
    }

    setLoading(false);
  };

  const handleSelectDirectory = (dirPath) => {
    onChange(dirPath);
    setIsOpen(false);
  };

  const handleNavigate = (path) => {
    loadDirectories(path);
  };

  return (
    <div className="relative">
      <label className="block text-sm text-gray-400 mb-1">{label} *</label>

      {/* Selected Directory Display */}
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white focus:border-port-accent focus:outline-none font-mono text-left flex items-center justify-between"
      >
        <span className="truncate">{value || currentPath || 'Select a directory...'}</span>
        <ChevronRight size={16} className={`flex-shrink-0 transition-transform ${isOpen ? 'rotate-90' : ''}`} />
      </button>

      {/* Directory Browser Dropdown */}
      {isOpen && (
        <div className="absolute z-50 mt-1 w-full bg-port-card border border-port-border rounded-lg shadow-xl max-h-96 overflow-hidden flex flex-col">
          {/* Current Path Header */}
          <div className="sticky top-0 bg-port-card border-b border-port-border p-3 flex items-center gap-2">
            <Folder size={16} className="text-port-accent flex-shrink-0" />
            <span className="text-sm text-gray-400 truncate font-mono">{currentPath}</span>
          </div>

          {/* Navigation Controls */}
          <div className="border-b border-port-border p-2 flex gap-2">
            {parentPath && (
              <button
                type="button"
                onClick={() => handleNavigate(parentPath)}
                className="flex items-center gap-2 px-3 py-1.5 text-sm text-gray-400 hover:text-white hover:bg-port-border rounded transition-colors"
                disabled={loading}
              >
                <ArrowUp size={14} />
                <span>Parent</span>
              </button>
            )}
            <button
              type="button"
              onClick={() => handleNavigate(null)}
              className="flex items-center gap-2 px-3 py-1.5 text-sm text-gray-400 hover:text-white hover:bg-port-border rounded transition-colors"
              disabled={loading}
            >
              <Home size={14} />
              <span>Default</span>
            </button>
            <button
              type="button"
              onClick={() => handleSelectDirectory(currentPath)}
              className="ml-auto px-3 py-1.5 text-sm bg-port-accent hover:bg-port-accent/80 text-white rounded transition-colors"
              disabled={loading}
            >
              Select Current
            </button>
          </div>

          {/* Directory List */}
          <div className="overflow-y-auto flex-1">
            {loading ? (
              <div className="flex items-center justify-center p-8">
                <Loader2 size={24} className="text-gray-500 animate-spin" />
              </div>
            ) : error ? (
              <div className="p-4 text-center text-port-error text-sm">{error}</div>
            ) : directories.length === 0 ? (
              <div className="p-4 text-center text-gray-500 text-sm">No subdirectories</div>
            ) : (
              <div className="p-2">
                {directories.map(dir => (
                  <button
                    key={dir.path}
                    type="button"
                    onClick={() => handleNavigate(dir.path)}
                    onDoubleClick={() => handleSelectDirectory(dir.path)}
                    className="w-full flex items-center gap-2 px-3 py-2 text-sm text-gray-300 hover:text-white hover:bg-port-border rounded transition-colors group"
                  >
                    <Folder size={14} className="text-gray-500 group-hover:text-port-accent flex-shrink-0" />
                    <span className="truncate">{dir.name}</span>
                    <ChevronRight size={14} className="ml-auto flex-shrink-0 text-gray-600 group-hover:text-gray-400" />
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Footer Help */}
          <div className="border-t border-port-border p-2 text-xs text-gray-500">
            Double-click a folder to select it, or use "Select Current"
          </div>
        </div>
      )}
    </div>
  );
}
