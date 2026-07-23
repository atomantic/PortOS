import { request } from './apiCore.js';

export const listThreejsModels = (options) => request('/threejs-models', options);

export const getThreejsModel = (id, options) =>
  request(`/threejs-models/${encodeURIComponent(id)}`, options);

export const createThreejsModel = (input, options) =>
  request('/threejs-models', {
    method: 'POST',
    body: JSON.stringify(input),
    ...options,
  });

export const generateThreejsModel = (id, input, options) =>
  request(`/threejs-models/${encodeURIComponent(id)}/generate`, {
    method: 'POST',
    body: JSON.stringify(input),
    ...options,
  });

export const deleteThreejsModel = (id, options) =>
  request(`/threejs-models/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    ...options,
  });

export const getThreejsModelSource = (id, options) =>
  request(`/threejs-models/${encodeURIComponent(id)}/source`, {
    responseType: 'text',
    ...options,
  });

export const threejsModelSourceUrl = (id) =>
  `/api/threejs-models/${encodeURIComponent(id)}/source`;
