/** Extract the pinned model id from provider.args when a model flag is baked in. */
export function extractBakedModel(args) {
  if (!Array.isArray(args)) return null;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (typeof arg !== 'string') continue;
    if (arg === '--model' || arg === '-m') {
      const next = args[i + 1];
      return typeof next === 'string' && next.length > 0 && !next.startsWith('-') ? next : null;
    }
    if (arg.startsWith('--model=')) return arg.slice('--model='.length) || null;
    if (arg.startsWith('-m=')) return arg.slice('-m='.length) || null;
  }
  return null;
}
