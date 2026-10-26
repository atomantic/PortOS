import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';

const clientRoot = fileURLToPath(new URL('../../client/', import.meta.url));
const requireClient = createRequire(new URL('../../client/package.json', import.meta.url));
const html = `<!doctype html><html><head><meta charset="utf-8">
<style>html,body,#root{margin:0;width:100%;height:100%}canvas{display:block}</style>
</head><body><div id="root"></div><script src="/viewer.js"></script></body></html>`;
let page;

// Compile the same viewer on first demand, never at boot. Nothing is served by
// Vite: its in-memory output is staged as the jailed browser's only script.
export function getGreyboxCapturePage() {
  page ??= (async () => {
    const { build } = await import(pathToFileURL(requireClient.resolve('vite')).href);
    const result = await build({
      configFile: false, envFile: false, publicDir: false, root: clientRoot, logLevel: 'error',
      cacheDir: join(clientRoot, '.cache/vite-greybox'),
      resolve: { conditions: ['module', 'browser', 'production'], dedupe: ['react', 'react-dom', 'three'] },
      oxc: { jsx: { runtime: 'automatic', development: false } },
      define: { 'process.env.NODE_ENV': JSON.stringify('production') },
      build: {
        write: false,
        lib: { entry: join(clientRoot, 'src/components/catalog/GreyboxCapture.jsx'), name: 'GreyboxCapture', formats: ['iife'] },
      },
    });
    const chunks = [result].flat().flatMap((output) => output.output).filter((asset) => asset.type === 'chunk');
    if (chunks.length !== 1 || chunks[0].imports.length || chunks[0].dynamicImports.length) {
      throw new Error('Greybox viewer must be a self-contained bundle');
    }
    return { html, script: chunks[0].code };
  })().catch((error) => { page = undefined; throw error; });
  return page;
}
