import { useState } from 'react';
import { Zap, ClipboardPaste, Eraser } from 'lucide-react';
import RapidReader from '../components/RapidReader';

const SAMPLE = `Speed reading is a collection of techniques used to scan text quickly while still understanding what you've read. Most people read in chunks of three or four words at a time, which slows them down. Rapid serial visual presentation flashes one word at a time at a fixed location, removing the need to move your eyes. With practice, comprehension stays intact at three to five hundred words per minute, and many readers can push past six hundred for familiar material.`;

const focalPalette = [
  { value: '#ef4444', label: 'Red' },
  { value: '#f59e0b', label: 'Amber' },
  { value: '#22c55e', label: 'Green' },
  { value: '#3b82f6', label: 'Blue' },
  { value: '#a855f7', label: 'Purple' }
];

export default function RapidReaderPage() {
  const [text, setText] = useState('');
  const [active, setActive] = useState('');
  const [wpm, setWpm] = useState(350);
  const [chunkSize, setChunkSize] = useState(1);
  const [focalColor, setFocalColor] = useState('#ef4444');

  const start = () => {
    const trimmed = text.trim();
    if (!trimmed) return;
    setActive(trimmed);
  };

  const reset = () => {
    setActive('');
  };

  const pasteFromClipboard = async () => {
    if (!navigator.clipboard?.readText) return;
    const t = await navigator.clipboard.readText().catch(() => '');
    if (t) setText(t);
  };

  const wordCount = text.trim() ? text.trim().split(/\s+/).length : 0;
  const estSec = Math.round((wordCount * 60) / Math.max(60, wpm));

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Zap className="w-5 h-5 text-port-accent" />
        <div>
          <h1 className="text-xl font-semibold text-white">Rapid Reader</h1>
          <p className="text-sm text-gray-400">
            Paste text and read it word-by-word with a highlighted focal letter (Spritz-style RSVP).
          </p>
        </div>
      </div>

      {active ? (
        <div className="space-y-4">
          <RapidReader
            text={active}
            wpm={wpm}
            chunkSize={chunkSize}
            focalColor={focalColor}
            autoPlay
            onClose={reset}
          />
          <div className="flex flex-wrap items-center gap-3 text-xs text-gray-500">
            <span>Space = play/pause · ← → step · R restart · +/− WPM · Esc close</span>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="bg-port-card border border-port-border rounded-lg p-4 space-y-3">
            <div className="flex items-center justify-between gap-2">
              <label htmlFor="rr-text" className="text-sm font-medium text-gray-300">
                Text to read
              </label>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={pasteFromClipboard}
                  className="inline-flex items-center gap-1.5 min-h-10 px-2.5 py-1.5 text-xs rounded-md border border-port-border text-gray-400 hover:text-white hover:border-port-accent/50"
                  title="Paste from clipboard"
                >
                  <ClipboardPaste size={12} /> Paste
                </button>
                <button
                  type="button"
                  onClick={() => setText(SAMPLE)}
                  className="inline-flex items-center gap-1.5 min-h-10 px-2.5 py-1.5 text-xs rounded-md border border-port-border text-gray-400 hover:text-white hover:border-port-accent/50"
                >
                  Sample
                </button>
                {text && (
                  <button
                    type="button"
                    onClick={() => setText('')}
                    className="inline-flex items-center gap-1.5 min-h-10 px-2.5 py-1.5 text-xs rounded-md border border-port-border text-gray-400 hover:text-white hover:border-port-accent/50"
                    title="Clear"
                  >
                    <Eraser size={12} /> Clear
                  </button>
                )}
              </div>
            </div>
            <textarea
              id="rr-text"
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={10}
              placeholder="Paste an article, email, briefing, or any prose…"
              className="w-full bg-port-bg border border-port-border rounded-md px-3 py-2 text-sm text-gray-200 placeholder-gray-600 font-mono focus:outline-none focus:border-port-accent/60"
            />
            <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-gray-500">
              <span>
                {wordCount} word{wordCount === 1 ? '' : 's'} · approx {estSec}s at {wpm} WPM
              </span>
            </div>
          </div>

          <div className="bg-port-card border border-port-border rounded-lg p-4 space-y-4">
            <div className="text-sm font-medium text-gray-300">Settings</div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <label className="flex flex-col gap-1.5 text-xs text-gray-400">
                <span>Words per minute</span>
                <div className="flex items-center gap-3">
                  <input
                    type="range"
                    min={100}
                    max={1000}
                    step={25}
                    value={wpm}
                    onChange={(e) => setWpm(Number(e.target.value))}
                    className="flex-1 accent-port-accent"
                  />
                  <span className="font-mono text-sm text-gray-200 w-12 text-right">{wpm}</span>
                </div>
              </label>

              <div className="flex flex-col gap-1.5 text-xs text-gray-400">
                <span>Chunk size</span>
                <div className="flex border border-port-border rounded-md overflow-hidden">
                  <button
                    type="button"
                    onClick={() => setChunkSize(1)}
                    className={`flex-1 min-h-10 px-3 text-sm ${chunkSize === 1 ? 'bg-port-accent/20 text-port-accent' : 'text-gray-400 hover:text-white'}`}
                  >
                    1 word
                  </button>
                  <button
                    type="button"
                    onClick={() => setChunkSize(2)}
                    className={`flex-1 min-h-10 px-3 text-sm border-l border-port-border ${chunkSize === 2 ? 'bg-port-accent/20 text-port-accent' : 'text-gray-400 hover:text-white'}`}
                  >
                    2 words
                  </button>
                </div>
              </div>

              <div className="flex flex-col gap-1.5 text-xs text-gray-400">
                <span>Focal color</span>
                <div className="flex gap-2 flex-wrap">
                  {focalPalette.map((c) => (
                    <button
                      key={c.value}
                      type="button"
                      onClick={() => setFocalColor(c.value)}
                      title={c.label}
                      aria-label={`Focal ${c.label}`}
                      className={`w-9 h-9 rounded-md border-2 transition-colors ${focalColor === c.value ? 'border-white' : 'border-port-border hover:border-gray-400'}`}
                      style={{ backgroundColor: c.value }}
                    />
                  ))}
                </div>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={start}
              disabled={!text.trim()}
              className="inline-flex items-center gap-2 min-h-10 px-4 py-2 rounded-lg bg-port-accent text-white font-medium disabled:opacity-40 disabled:cursor-not-allowed hover:bg-port-accent/90"
            >
              <Zap size={16} /> Start reading
            </button>
            <span className="text-xs text-gray-500">
              Tip: many surfaces in PortOS expose a Rapid Read button — Briefing, Wiki notes, and more.
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
