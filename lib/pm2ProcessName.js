// A PM2 process name taken from a request becomes a positional argument to the
// pm2 CLI, whose option parser would read a leading `-` as a flag. The API
// (server/lib/validation.js) and the Autofixer sidecar share this one rule.
export const PM2_PROCESS_NAME_MAX = 120;
export const PM2_PROCESS_NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;

export const isPm2ProcessName = (value) => typeof value === 'string'
  && value.length <= PM2_PROCESS_NAME_MAX && PM2_PROCESS_NAME_RE.test(value);
