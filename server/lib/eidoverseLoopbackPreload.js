// Bun `--preload` module that keeps the managed Eidoverse sequencer on loopback by wrapping `Bun.serve`.
//
// Upstream hardcodes `hostname: "0.0.0.0"` and reads no bind-address variable,
// and PortOS does not edit the external checkout (#17865). Everything that needs
// the sequencer reaches it on 127.0.0.1; browsers come through PortOS's gated
// proxy. Must stay importable by Bun with no PortOS runtime state: it runs inside
// the third-party process. Under Node (tests) there is no global `Bun`.
import { EIDOVERSE_PORT } from './eidoversePort.js';

const LOOPBACK = '127.0.0.1';

// Bun falls back to these variables when `serve` gets no port.
const requestedPort = (options, env) => Number(
  options?.port ?? env.BUN_PORT ?? env.PORT ?? env.NODE_PORT ?? 3000,
);

export function installLoopbackServe(bun, env = process.env) {
  const serve = bun.serve;
  bun.serve = (options, ...rest) => serve.call(
    bun,
    requestedPort(options, env) === EIDOVERSE_PORT ? { ...options, hostname: LOOPBACK } : options,
    ...rest,
  );
}

if (globalThis.Bun) installLoopbackServe(globalThis.Bun);
