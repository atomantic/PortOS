/** Shares the initial shell response and hands each field off to its live owner. */

let startup;
const consumed = new Set();

export function startShellBootstrap(read) {
  startup ??= read()
    .then(data => ({ data }), error => ({ error }));
}

export function readShellBootstrap(field, fallback) {
  if (!startup || consumed.has(field)) return fallback();
  return startup.then(({ data, error }) => {
    consumed.add(field);
    if (error?.code === 'AUTH_REQUIRED') throw error;
    if (data?.[field] == null) return fallback();
    return data[field];
  });
}
