// Imported lazily after the browser prerequisites are present. Resolve Vite
// and its React plugin from the same workspace as the components under test.
export { createServer } from 'vite';
export { default as react } from '@vitejs/plugin-react';
