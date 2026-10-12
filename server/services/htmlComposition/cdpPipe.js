import { EventEmitter } from 'node:events';

/**
 * WebSocket-shaped adapter for Chrome's `--remote-debugging-pipe`.
 * Chrome reads commands from fd 3 and writes replies to fd 4. Messages are
 * UTF-8 JSON terminated by a NUL byte. These pipes are not IP sockets, so the
 * browser can run with every network address denied.
 */
export function createCdpPipeTransport(proc) {
  const input = proc.stdio?.[3];
  const output = proc.stdio?.[4];
  const emitter = new EventEmitter();
  let buffer = Buffer.alloc(0);
  let open = true;
  let failure;
  const fail = (error) => {
    if (!open) return;
    failure ??= error;
    emitter.emit('error', failure);
  };
  const onData = (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    let index = buffer.indexOf(0);
    while (index !== -1) {
      const raw = buffer.subarray(0, index);
      buffer = buffer.subarray(index + 1);
      if (raw.length) emitter.emit('message', raw);
      index = buffer.indexOf(0);
    }
  };
  output?.on('data', onData);
  output?.on('end', () => {
    open = false;
    transport.readyState = 3;
    emitter.emit('close');
  });
  output?.on('error', fail);
  input?.on('error', fail);
  const transport = {
    readyState: 1,
    send(text, callback) {
      if (failure) {
        callback?.(failure);
        return;
      }
      if (!open || !input?.writable) {
        callback?.(new Error('CDP pipe is closed'));
        return;
      }
      input.write(Buffer.concat([Buffer.from(String(text), 'utf8'), Buffer.from([0])]), callback);
    },
    terminate() {
      open = false;
      transport.readyState = 3;
      input?.destroy();
      output?.destroy();
    },
    on: emitter.on.bind(emitter),
    once: emitter.once.bind(emitter),
    off: emitter.off.bind(emitter),
    removeListener: emitter.removeListener.bind(emitter),
  };
  return transport;
}
