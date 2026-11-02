const DISABLED_SANDBOX_FLAGS = new Set([
  '--no-sandbox', '--disable-setuid-sandbox', '--disable-seccomp-filter-sandbox', '--disable-gpu-sandbox',
]);

export function sandboxedChromiumOptions(options = {}) {
  if (options.chromiumSandbox === false || options.args?.some(arg =>
    typeof arg === 'string' && DISABLED_SANDBOX_FLAGS.has(arg.split('=')[0]))) {
    throw new Error('Chromium sandbox cannot be disabled in browser fixtures');
  }
  return { ...options, chromiumSandbox: true };
}
