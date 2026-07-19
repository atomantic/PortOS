import js from '@eslint/js';
import reactPlugin from 'eslint-plugin-react';
import reactHooksPlugin from 'eslint-plugin-react-hooks';

const browserGlobals = {
  window: 'readonly', document: 'readonly', navigator: 'readonly',
  location: 'readonly', history: 'readonly', screen: 'readonly',
  console: 'readonly', alert: 'readonly', confirm: 'readonly', prompt: 'readonly',
  setTimeout: 'readonly', clearTimeout: 'readonly',
  setInterval: 'readonly', clearInterval: 'readonly',
  requestAnimationFrame: 'readonly', cancelAnimationFrame: 'readonly',
  queueMicrotask: 'readonly',
  fetch: 'readonly', URL: 'readonly', URLSearchParams: 'readonly',
  EventSource: 'readonly',
  FormData: 'readonly', File: 'readonly', FileReader: 'readonly',
  Blob: 'readonly', Event: 'readonly', CustomEvent: 'readonly',
  DOMException: 'readonly',
  EventTarget: 'readonly', AbortController: 'readonly', AbortSignal: 'readonly',
  ReadableStream: 'readonly', WritableStream: 'readonly', TransformStream: 'readonly',
  DecompressionStream: 'readonly',
  localStorage: 'readonly', sessionStorage: 'readonly', indexedDB: 'readonly',
  caches: 'readonly',
  performance: 'readonly', crypto: 'readonly',
  Worker: 'readonly', SharedWorker: 'readonly', MessageChannel: 'readonly',
  MessageEvent: 'readonly', BroadcastChannel: 'readonly',
  HTMLElement: 'readonly', HTMLInputElement: 'readonly', HTMLCanvasElement: 'readonly',
  HTMLVideoElement: 'readonly', HTMLTextAreaElement: 'readonly',
  HTMLMediaElement: 'readonly', HTMLAudioElement: 'readonly',
  HTMLButtonElement: 'readonly', HTMLDivElement: 'readonly', HTMLSelectElement: 'readonly',
  Element: 'readonly', Node: 'readonly', NodeList: 'readonly', Text: 'readonly',
  DOMParser: 'readonly',
  MutationObserver: 'readonly', IntersectionObserver: 'readonly',
  ResizeObserver: 'readonly',
  WebGLRenderingContext: 'readonly', WebGL2RenderingContext: 'readonly',
  ArrayBuffer: 'readonly', Uint8Array: 'readonly', Uint16Array: 'readonly',
  Uint32Array: 'readonly', Int8Array: 'readonly', Int16Array: 'readonly',
  Int32Array: 'readonly', Float32Array: 'readonly', Float64Array: 'readonly',
  DataView: 'readonly', TextDecoder: 'readonly', TextEncoder: 'readonly',
  atob: 'readonly', btoa: 'readonly',
  Image: 'readonly', Audio: 'readonly', SVGElement: 'readonly',
  getComputedStyle: 'readonly', matchMedia: 'readonly',
  self: 'readonly', globalThis: 'readonly',
  CSS: 'readonly',
  AudioContext: 'readonly', OfflineAudioContext: 'readonly',
  AudioWorkletNode: 'readonly', MediaRecorder: 'readonly',
  MediaStream: 'readonly', MediaStreamTrack: 'readonly',
  RTCPeerConnection: 'readonly', RTCSessionDescription: 'readonly',
  WebSocket: 'readonly', SpeechRecognition: 'readonly',
  webkitSpeechRecognition: 'readonly', SpeechSynthesisUtterance: 'readonly',
  speechSynthesis: 'readonly',
};

const nodeGlobals = {
  // process/Buffer are injected by Vite for compatibility; global/setImmediate for some polyfills
  process: 'readonly', Buffer: 'readonly', global: 'readonly',
  setImmediate: 'readonly', clearImmediate: 'readonly',
  // __dirname, __filename, require, module, exports omitted — not valid in ESM browser bundles
};

export default [
  {
    ignores: ['dist/**', 'node_modules/**'],
  },
  js.configs.recommended,
  {
    files: ['src/**/*.{js,jsx}'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      parserOptions: {
        ecmaFeatures: {
          jsx: true,
        },
      },
      globals: {
        ...browserGlobals,
        ...nodeGlobals,
      },
    },
    plugins: {
      react: reactPlugin,
      'react-hooks': reactHooksPlugin,
    },
    settings: {
      react: {
        version: 'detect',
      },
    },
    rules: {
      ...reactPlugin.configs.recommended.rules,
      ...reactHooksPlugin.configs.recommended.rules,
      'react/react-in-jsx-scope': 'off',
      'react/prop-types': 'off',
      'react/no-unknown-property': 'off',
      'react/no-unescaped-entities': 'off',
      'react/jsx-no-comment-textnodes': 'off',
      // Lint policy: every rule is either 'error' (enforced) or 'off' (gone). We do
      // not use 'warn' — a warning is a rule nobody acts on, i.e. noise that hides
      // real errors. If we don't want to enforce a rule, we disable it outright.
      'no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_'
      }],
      'no-undef': 'error',
      // `crypto.randomUUID` only exists in a SECURE context. PortOS is routinely
      // reached over plain HTTP via Tailscale, where it is undefined — so every
      // bare call is a crash for the users on that deployment (it took out every
      // toast until `lib/uuid.js` landed). The footgun was independently
      // rediscovered at half a dozen sites, each inventing a different
      // workaround, so a shared helper alone was not enough to stop it: this
      // rule is what actually holds the line. `no-restricted-properties` is NOT
      // a substitute — it misses `globalThis.crypto.randomUUID`.
      'no-restricted-syntax': ['error', {
        selector: "MemberExpression[property.name='randomUUID']",
        message: 'crypto.randomUUID is undefined on insecure origins (PortOS over plain HTTP via Tailscale). Import { uuidv4 } from lib/uuid.js instead.',
      }],
      'no-useless-escape': 'error',
      'react-hooks/rules-of-hooks': 'error',
      // exhaustive-deps is dominated by the deliberate run-once-on-mount pattern across
      // this codebase; rather than enforce-and-suppress it everywhere we turn it off and
      // manage effect dependencies by review. rules-of-hooks (above) stays enforced.
      'react-hooks/exhaustive-deps': 'off',
      // eslint-plugin-react-hooks v7's `recommended` preset newly enables the React
      // Compiler rule set. PortOS does not run the React Compiler, and these rules
      // flag intentional, correct idioms across the codebase (async-loader effects,
      // the mirror-prop-into-ref pattern for animation/async callbacks, and THREE.js
      // useFrame mutations). We disable the compiler-specific rules rather than scatter
      // hundreds of inline suppressions. Revisit if/when PortOS adopts the React Compiler.
      'react-hooks/set-state-in-effect': 'off',
      'react-hooks/refs': 'off',
      'react-hooks/purity': 'off',
      'react-hooks/immutability': 'off',
      'react-hooks/preserve-manual-memoization': 'off',
      'react-hooks/static-components': 'off',
      'react-hooks/globals': 'off',
    },
  },
  {
    // `lib/uuid.js` is the one place allowed to probe `crypto.randomUUID` — it
    // exists to wrap it. Tests may reference it to simulate an insecure origin.
    files: ['src/lib/uuid.js', 'src/**/*.test.{js,jsx}'],
    rules: {
      'no-restricted-syntax': 'off',
    },
  },
];
