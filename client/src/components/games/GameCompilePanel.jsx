import { Boxes, RefreshCw } from 'lucide-react';
import { formatDateShort } from '../../utils/formatters.js';

export default function GameCompilePanel({ game, compiling, onCompile }) {
  const current = game.compiledManifest;
  return (
    <section className="rounded-xl border border-port-border bg-port-card p-4">
      <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-start">
        <div>
          <div className="flex items-center gap-2">
            <Boxes className="h-5 w-5 text-port-accent" aria-hidden="true" />
            <h2 className="font-semibold text-white">Game asset bundle</h2>
          </div>
          <p className="mt-1 text-sm text-gray-400">
            Compile immutable sprite-atlas and music references into a deterministic manifest.
          </p>
        </div>
        <button
          type="button"
          onClick={onCompile}
          disabled={compiling}
          className="inline-flex min-h-[44px] items-center justify-center gap-2 rounded-lg bg-port-accent px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          <RefreshCw className={`h-4 w-4 ${compiling ? 'animate-spin' : ''}`} aria-hidden="true" />
          {current ? 'Recompile' : 'Compile bundle'}
        </button>
      </div>

      {current ? (
        <dl className="mt-4 grid gap-3 rounded-lg border border-port-border bg-port-bg/50 p-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
          <div><dt className="text-xs text-gray-500">Version</dt><dd className="text-white">v{current.version}</dd></div>
          <div><dt className="text-xs text-gray-500">Sprites</dt><dd className="text-white">{current.spriteCount}</dd></div>
          <div><dt className="text-xs text-gray-500">Music</dt><dd className="text-white">{current.musicCount}</dd></div>
          <div><dt className="text-xs text-gray-500">Built</dt><dd className="text-white">{formatDateShort(current.builtAt)}</dd></div>
          <div className="min-w-0 sm:col-span-2 lg:col-span-4">
            <dt className="text-xs text-gray-500">Manifest</dt>
            <dd className="truncate font-mono text-xs text-gray-300" title={current.manifestPath}>{current.manifestPath}</dd>
          </div>
        </dl>
      ) : (
        <p className="mt-4 rounded-lg border border-dashed border-port-border p-4 text-sm text-gray-500">
          No bundle compiled yet. Bound sprites need a current runtime atlas and bound tracks need audio.
        </p>
      )}
    </section>
  );
}
