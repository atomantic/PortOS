import { request } from './apiCore.js';

// Ports
export const scanPorts = () => request('/ports/scan');
export const checkPorts = (ports) => request('/ports/check', {
  method: 'POST',
  body: JSON.stringify({ ports })
});
export const allocatePorts = (count = 1) => request('/ports/allocate', {
  method: 'POST',
  body: JSON.stringify({ count })
});

// Detect
export const detectRepo = (path) => request('/detect/repo', {
  method: 'POST',
  body: JSON.stringify({ path })
});

export const detectPort = (port) => request('/detect/port', {
  method: 'POST',
  body: JSON.stringify({ port })
});

export const detectPm2 = (name) => request('/detect/pm2', {
  method: 'POST',
  body: JSON.stringify({ name })
});

export const detectWithAi = (path, providerId) => request('/detect/ai', {
  method: 'POST',
  body: JSON.stringify({ path, providerId })
});
