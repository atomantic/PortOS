import { useState, useRef, useEffect } from 'react';
import { Rocket, X, ChevronDown } from 'lucide-react';
import BrailleSpinner from '../BrailleSpinner';
import { useAppDeploy } from '../../hooks/useAppDeploy';

const FLAG_OPTIONS = [
  { value: '--ios', label: 'iOS' },
  { value: '--macos', label: 'macOS' },
  { value: '--watch', label: 'watchOS' },
  { value: '--all', label: 'All Platforms' },
  { value: '--skip-tests', label: 'Skip Tests' },
];

const PLATFORM_FLAGS = new Set(['--ios', '--macos', '--watch', '--all']);

export default function DeployPanel({ appId, appName }) {
  const { output, isDeploying, error, result, startDeploy, clearDeploy } = useAppDeploy();
  const [showOptions, setShowOptions] = useState(false);
  const [selectedFlags, setSelectedFlags] = useState([]);
  const [dismissed, setDismissed] = useState(false);
  const outputRef = useRef(null);
  const rafRef = useRef(null);
  const hasState = isDeploying || output.length > 0 || error || result;
  const isOpen = hasState && !dismissed;

  // Throttled auto-scroll via rAF
  useEffect(() => {
    if (!outputRef.current) return;
    if (rafRef.current) return;
    rafRef.current = requestAnimationFrame(() => {
      if (outputRef.current) outputRef.current.scrollTop = outputRef.current.scrollHeight;
      rafRef.current = null;
    });
  }, [output]);

  useEffect(() => () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); }, []);

  // Esc to dismiss the modal (deploy keeps running in the background)
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e) => { if (e.key === 'Escape') setDismissed(true); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen]);

  const toggleFlag = (flag) => {
    setSelectedFlags(prev => {
      if (PLATFORM_FLAGS.has(flag)) {
        if (prev.includes(flag)) return prev.filter(f => f !== flag);
        return flag === '--all'
          ? [...prev.filter(f => !PLATFORM_FLAGS.has(f)), '--all']
          : [...prev.filter(f => f !== '--all'), flag];
      }
      return prev.includes(flag) ? prev.filter(f => f !== flag) : [...prev, flag];
    });
  };

  const handleDeploy = () => {
    setShowOptions(false);
    setDismissed(false);
    // If a deploy is already running and the modal was dismissed, just reopen it
    // instead of triggering another deploy (the backend would reject as duplicate).
    if (isDeploying) return;
    startDeploy(appId, selectedFlags);
  };

  const handleClose = () => {
    if (isDeploying) {
      // Hide the modal but keep state — deploy continues server-side.
      setDismissed(true);
    } else {
      // Deploy is finished; clear state so the panel resets.
      clearDeploy();
      setDismissed(false);
    }
  };

  return (
    <div className="relative inline-flex">
      <div className="inline-flex rounded-lg overflow-hidden border border-port-border">
        <button
          onClick={handleDeploy}
          className="px-2 py-1 bg-purple-500/20 text-purple-400 hover:bg-purple-500/30 transition-colors flex items-center gap-1"
          title={isDeploying && dismissed ? 'Show deploy output' : undefined}
        >
          <Rocket size={14} className={isDeploying ? 'animate-pulse' : ''} />
          <span className="text-xs">
            {isDeploying ? (dismissed ? 'View deploy…' : 'Deploying…') : 'Deploy'}
          </span>
        </button>
        <button
          onClick={() => setShowOptions(prev => !prev)}
          disabled={isDeploying}
          className="px-1 py-1 bg-purple-500/20 text-purple-400 hover:bg-purple-500/30 transition-colors disabled:opacity-50 border-l border-port-border"
        >
          <ChevronDown size={12} />
        </button>
      </div>

      {showOptions && (
        <div className="absolute top-full right-0 mt-1 z-50 bg-port-card border border-port-border rounded-lg shadow-xl p-2 min-w-[160px]">
          {FLAG_OPTIONS.map(opt => (
            <label key={opt.value} className="flex items-center gap-2 px-2 py-1.5 hover:bg-port-border/50 rounded cursor-pointer">
              <input
                type="checkbox"
                checked={selectedFlags.includes(opt.value)}
                onChange={() => toggleFlag(opt.value)}
                className="accent-purple-500"
              />
              <span className="text-xs text-gray-300">{opt.label}</span>
            </label>
          ))}
          <div className="border-t border-port-border mt-1 pt-1">
            <button
              onClick={handleDeploy}
              className="w-full px-2 py-1.5 text-xs bg-purple-500/20 text-purple-400 hover:bg-purple-500/30 rounded transition-colors"
            >
              Deploy{selectedFlags.length > 0 ? ` (${selectedFlags.join(' ')})` : ''}
            </button>
          </div>
        </div>
      )}

      {isOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
          onClick={(e) => { if (e.target === e.currentTarget) handleClose(); }}
        >
          <div className="bg-port-bg border border-port-border rounded-xl shadow-2xl w-full max-w-3xl max-h-[80vh] flex flex-col">
            <div className="flex items-center justify-between px-4 py-3 border-b border-port-border">
              <div className="flex items-center gap-2">
                <Rocket size={16} className="text-purple-400" />
                <span className="text-sm font-medium text-white">Deploy: {appName}</span>
                {isDeploying && <BrailleSpinner text="" className="text-xs text-purple-400" />}
              </div>
              <button
                onClick={handleClose}
                className="text-gray-400 hover:text-white transition-colors"
                title={isDeploying ? 'Hide (deploy keeps running)' : 'Close'}
                aria-label={isDeploying ? 'Hide deploy output' : 'Close deploy panel'}
              >
                <X size={16} />
              </button>
            </div>

            <div
              ref={outputRef}
              className="flex-1 overflow-auto p-4 font-mono text-xs leading-relaxed bg-black/40"
            >
              {output.map((line, i) => (
                <div
                  key={i}
                  className={
                    line.stream === 'stderr' ? 'text-port-error whitespace-pre-wrap break-words' :
                    line.stream === 'status' ? 'text-purple-400 font-bold whitespace-pre-wrap break-words' :
                    'text-gray-300 whitespace-pre-wrap break-words'
                  }
                >
                  {line.text}
                </div>
              ))}
              {error && <div className="text-port-error mt-2 whitespace-pre-wrap break-words">Error: {error}</div>}
            </div>

            {result && (
              <div className={`px-4 py-2 border-t border-port-border text-xs ${result.success ? 'text-port-success' : 'text-port-error'}`}>
                {result.success ? 'Deploy completed successfully' : `Deploy failed (exit code ${result.code})`}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
