/** Default loopback endpoint and explicit terminal launch recipe for the optional Splash runtime. */

export const SPLASH_ORIGIN = 'http://127.0.0.1:8001';
export const SPLASH_MODEL = 'inkling2-mini';
export const SPLASH_CONTEXT = 65536;
export const SPLASH_RELEASE_URL = 'https://github.com/incoai/splash/releases/tag/1.7.2';

export const SPLASH_LAUNCH_COMMAND = [
  'splash serve',
  '--model unsloth/Inkling-2-Mini-GGUF:UD-Q4_K_M',
  '--host 127.0.0.1',
  `--port ${new URL(SPLASH_ORIGIN).port}`,
  `--served-model-name ${SPLASH_MODEL}`,
  '--announce-served-name',
  '--language-only',
  `--max-context ${SPLASH_CONTEXT}`,
].join(' ');
