/**
 * DataDog API Service
 * Supports multiple DataDog instances with API/App key authentication
 */

import axios from 'axios';
import fs from 'fs/promises';
import path from 'path';
import { PATHS, readJSONFile } from '../lib/fileUtils.js';

const DATADOG_CONFIG_FILE = path.join(PATHS.data, 'datadog.json');

// Hostname-only pattern: no scheme, no path, no port, no special chars
const VALID_HOSTNAME_RE = /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)*$/;

function validateSite(site) {
  if (!site || !VALID_HOSTNAME_RE.test(site)) {
    throw new Error(`Invalid DataDog site hostname: "${site}". Must be a valid hostname (e.g., api.datadoghq.com)`);
  }
}

function sanitizeQueryValue(value) {
  return value.replace(/"/g, '');
}
/**
 * Get DataDog instances configuration
 */
export async function getInstances() {
  return await readJSONFile(DATADOG_CONFIG_FILE, { instances: {} });
}

/**
 * Save DataDog instances configuration
 */
export async function saveInstances(config) {
  await fs.mkdir(path.dirname(DATADOG_CONFIG_FILE), { recursive: true });
  await fs.writeFile(
    DATADOG_CONFIG_FILE,
    JSON.stringify(config, null, 2),
    'utf-8'
  );
}

/**
 * Add or update DataDog instance
 */
export async function upsertInstance(instanceId, instanceData) {
  validateSite(instanceData.site);
  const config = await getInstances();

  const existing = config.instances[instanceId];

  config.instances[instanceId] = {
    id: instanceId,
    name: instanceData.name,
    site: instanceData.site,
    apiKey: instanceData.apiKey || existing?.apiKey,
    appKey: instanceData.appKey || existing?.appKey,
    createdAt: existing?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  await saveInstances(config);
  return config.instances[instanceId];
}

/**
 * Delete DataDog instance
 */
export async function deleteInstance(instanceId) {
  const config = await getInstances();
  delete config.instances[instanceId];
  await saveInstances(config);
}

/**
 * Create axios client for DataDog instance
 */
function createDatadogClient(instance) {
  return axios.create({
    baseURL: `https://${instance.site}`,
    headers: {
      'DD-API-KEY': instance.apiKey,
      'DD-APPLICATION-KEY': instance.appKey,
      'Content-Type': 'application/json'
    },
    timeout: 30000
  });
}

/**
 * Test DataDog instance connection
 */
export async function testConnection(instanceId) {
  const config = await getInstances();
  const instance = config.instances[instanceId];

  if (!instance) {
    throw new Error(`DataDog instance ${instanceId} not found`);
  }

  const client = createDatadogClient(instance);

  try {
    await client.get('/api/v1/validate');
    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error.response?.data?.errors?.[0] || error.message
    };
  }
}

/**
 * Search for errors in DataDog logs
 */
export async function searchErrors(instanceId, serviceName, environment = 'production', fromTime) {
  const config = await getInstances();
  const instance = config.instances[instanceId];

  if (!instance) {
    throw new Error(`DataDog instance ${instanceId} not found`);
  }

  const client = createDatadogClient(instance);
  const from = fromTime || new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const response = await client.post('/api/v2/logs/events/search', {
    filter: {
      query: `status:error service:"${sanitizeQueryValue(serviceName)}" env:"${sanitizeQueryValue(environment)}"`,
      from
    },
    sort: '-timestamp',
    page: {
      limit: 100
    }
  });

  return response.data;
}

export default {
  getInstances,
  saveInstances,
  upsertInstance,
  deleteInstance,
  testConnection,
  searchErrors
};
