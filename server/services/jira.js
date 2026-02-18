/**
 * JIRA API Service
 * Supports multiple JIRA instances with Personal Access Tokens
 */

import axios from 'axios';
import https from 'https';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const JIRA_CONFIG_FILE = path.join(__dirname, '../../data/jira.json');

/**
 * Get JIRA instances configuration
 */
export async function getInstances() {
  try {
    const content = await fs.readFile(JIRA_CONFIG_FILE, 'utf-8');
    return JSON.parse(content);
  } catch (error) {
    if (error.code === 'ENOENT') {
      // Initialize with empty config
      const defaultConfig = { instances: {} };
      await saveInstances(defaultConfig);
      return defaultConfig;
    }
    throw error;
  }
}

/**
 * Save JIRA instances configuration
 */
export async function saveInstances(config) {
  await fs.writeFile(
    JIRA_CONFIG_FILE,
    JSON.stringify(config, null, 2),
    'utf-8'
  );
}

/**
 * Add or update JIRA instance
 */
export async function upsertInstance(instanceId, instanceData) {
  const config = await getInstances();

  config.instances[instanceId] = {
    id: instanceId,
    name: instanceData.name,
    baseUrl: instanceData.baseUrl,
    email: instanceData.email,
    apiToken: instanceData.apiToken, // PAT (Personal Access Token)
    createdAt: config.instances[instanceId]?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  await saveInstances(config);
  return config.instances[instanceId];
}

/**
 * Delete JIRA instance
 */
export async function deleteInstance(instanceId) {
  const config = await getInstances();
  delete config.instances[instanceId];
  await saveInstances(config);
}

/**
 * Create axios client for JIRA instance
 */
function createJiraClient(instance) {
  return axios.create({
    baseURL: instance.baseUrl,
    headers: {
      'Authorization': `Bearer ${instance.apiToken}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    },
    httpsAgent: new https.Agent({
      rejectUnauthorized: false // Allow self-signed certs for internal JIRA
    }),
    timeout: 30000
  });
}

/**
 * Test JIRA instance connection
 */
export async function testConnection(instanceId) {
  const config = await getInstances();
  const instance = config.instances[instanceId];

  if (!instance) {
    throw new Error(`JIRA instance ${instanceId} not found`);
  }

  const client = createJiraClient(instance);

  try {
    // Test with /rest/api/2/myself endpoint
    const response = await client.get('/rest/api/2/myself');
    return {
      success: true,
      user: response.data.displayName,
      email: response.data.emailAddress
    };
  } catch (error) {
    return {
      success: false,
      error: error.response?.data?.message || error.message
    };
  }
}

/**
 * Get projects for JIRA instance
 */
export async function getProjects(instanceId) {
  const config = await getInstances();
  const instance = config.instances[instanceId];

  if (!instance) {
    throw new Error(`JIRA instance ${instanceId} not found`);
  }

  const client = createJiraClient(instance);
  const response = await client.get('/rest/api/2/project');

  return response.data.map(project => ({
    key: project.key,
    name: project.name,
    id: project.id
  }));
}

/**
 * Create JIRA ticket
 */
export async function createTicket(instanceId, ticketData) {
  const config = await getInstances();
  const instance = config.instances[instanceId];

  if (!instance) {
    throw new Error(`JIRA instance ${instanceId} not found`);
  }

  const client = createJiraClient(instance);

  const issue = {
    fields: {
      project: {
        key: ticketData.projectKey
      },
      summary: ticketData.summary,
      description: ticketData.description || ticketData.summary,
      issuetype: {
        name: ticketData.issueType || 'Task'
      }
    }
  };

  // Add optional fields
  if (ticketData.assignee) {
    issue.fields.assignee = { name: ticketData.assignee };
  }

  if (ticketData.storyPoints) {
    issue.fields.customfield_10106 = ticketData.storyPoints;
  }

  if (ticketData.epicKey) {
    issue.fields.customfield_10101 = ticketData.epicKey;
  }

  if (ticketData.sprint) {
    issue.fields.customfield_10105 = ticketData.sprint;
  }

  if (ticketData.labels && ticketData.labels.length > 0) {
    issue.fields.labels = ticketData.labels;
  }

  const response = await client.post('/rest/api/2/issue', issue);

  const ticketId = response.data.key;
  const ticketUrl = `${instance.baseUrl}/browse/${ticketId}`;

  return {
    success: true,
    ticketId,
    url: ticketUrl,
    response: response.data
  };
}

/**
 * Update JIRA ticket
 */
export async function updateTicket(instanceId, ticketId, updates) {
  const config = await getInstances();
  const instance = config.instances[instanceId];

  if (!instance) {
    throw new Error(`JIRA instance ${instanceId} not found`);
  }

  const client = createJiraClient(instance);

  const payload = {
    fields: updates
  };

  await client.put(`/rest/api/2/issue/${ticketId}`, payload);

  return {
    success: true,
    ticketId,
    url: `${instance.baseUrl}/browse/${ticketId}`
  };
}

/**
 * Add comment to JIRA ticket
 */
export async function addComment(instanceId, ticketId, comment) {
  const config = await getInstances();
  const instance = config.instances[instanceId];

  if (!instance) {
    throw new Error(`JIRA instance ${instanceId} not found`);
  }

  const client = createJiraClient(instance);

  await client.post(`/rest/api/2/issue/${ticketId}/comment`, {
    body: comment
  });

  return { success: true };
}

/**
 * Transition JIRA ticket (change status)
 */
export async function transitionTicket(instanceId, ticketId, transitionId) {
  const config = await getInstances();
  const instance = config.instances[instanceId];

  if (!instance) {
    throw new Error(`JIRA instance ${instanceId} not found`);
  }

  const client = createJiraClient(instance);

  await client.post(`/rest/api/2/issue/${ticketId}/transitions`, {
    transition: { id: transitionId }
  });

  return { success: true };
}

/**
 * Get tickets assigned to user in current sprint for a project
 */
export async function getMyCurrentSprintTickets(instanceId, projectKey) {
  const config = await getInstances();
  const instance = config.instances[instanceId];

  if (!instance) {
    throw new Error(`JIRA instance ${instanceId} not found`);
  }

  const client = createJiraClient(instance);

  // JQL to find tickets assigned to current user in active sprint for the project
  const jql = `project = "${projectKey}" AND assignee = currentUser() AND sprint in openSprints() ORDER BY priority DESC, updated DESC`;

  try {
    const response = await client.get('/rest/api/2/search', {
      params: {
        jql,
        fields: 'summary,status,priority,issuetype,assignee,updated,customfield_10106',
        maxResults: 50
      }
    });

    return response.data.issues.map(issue => ({
      key: issue.key,
      summary: issue.fields.summary,
      status: issue.fields.status.name,
      statusCategory: issue.fields.status.statusCategory?.name,
      priority: issue.fields.priority?.name,
      issueType: issue.fields.issuetype?.name,
      storyPoints: issue.fields.customfield_10106,
      updated: issue.fields.updated,
      url: `${instance.baseUrl}/browse/${issue.key}`
    }));
  } catch (error) {
    console.error(`❌ Failed to fetch JIRA tickets: ${error.message}`);
    // Return empty array on error to avoid breaking the UI
    return [];
  }
}

export default {
  getInstances,
  saveInstances,
  upsertInstance,
  deleteInstance,
  testConnection,
  getProjects,
  createTicket,
  updateTicket,
  addComment,
  transitionTicket,
  getMyCurrentSprintTickets
};
