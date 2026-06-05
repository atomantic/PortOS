const FILTER_INSTALLED = Symbol.for('portos.consoleFiltersInstalled');

const SUPPRESSED_MESSAGES = new Set([
  'THREE.Clock: This module has been deprecated. Please use THREE.Timer instead.',
  'THREE.WebGLRenderer: Context Lost.',
]);

function shouldSuppress(args) {
  return args.length === 1 && typeof args[0] === 'string' && SUPPRESSED_MESSAGES.has(args[0]);
}

export function installConsoleFilters() {
  if (console[FILTER_INSTALLED]) return;

  const originalWarn = console.warn.bind(console);
  const originalLog = console.log.bind(console);
  const originalDebug = console.debug.bind(console);

  console.warn = (...args) => {
    if (shouldSuppress(args)) return;
    originalWarn(...args);
  };

  console.log = (...args) => {
    if (shouldSuppress(args)) return;
    originalLog(...args);
  };

  console.debug = (...args) => {
    if (shouldSuppress(args)) return;
    originalDebug(...args);
  };

  Object.defineProperty(console, FILTER_INSTALLED, {
    value: true,
    configurable: false,
  });
}

installConsoleFilters();
