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
  FormData: 'readonly', File: 'readonly', FileReader: 'readonly',
  Blob: 'readonly', Event: 'readonly', CustomEvent: 'readonly',
  EventTarget: 'readonly', AbortController: 'readonly', AbortSignal: 'readonly',
  ReadableStream: 'readonly', WritableStream: 'readonly', TransformStream: 'readonly',
  DecompressionStream: 'readonly',
  localStorage: 'readonly', sessionStorage: 'readonly', indexedDB: 'readonly',
  performance: 'readonly', crypto: 'readonly',
  Worker: 'readonly', SharedWorker: 'readonly', MessageChannel: 'readonly',
  MessageEvent: 'readonly', BroadcastChannel: 'readonly',
  HTMLElement: 'readonly', HTMLInputElement: 'readonly', HTMLCanvasElement: 'readonly',
  HTMLVideoElement: 'readonly', HTMLTextAreaElement: 'readonly',
  Element: 'readonly', Node: 'readonly', NodeList: 'readonly', Text: 'readonly',
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
      'no-unused-vars': ['warn', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_'
      }],
      'no-undef': 'error',
      'no-useless-escape': 'error',
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
];
