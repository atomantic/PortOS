import { useState, useEffect } from 'react';
import toast from 'react-hot-toast';
import api from '../services/api';

const TOKEN_LIFETIME_DAYS = 30;
const TOKEN_WARN_DAYS = 5;

function getTokenExpiry(tokenUpdatedAt) {
  if (!tokenUpdatedAt) return null;
  const updated = new Date(tokenUpdatedAt);
  const expiresAt = new Date(updated.getTime() + TOKEN_LIFETIME_DAYS * 86400000);
  const daysLeft = Math.ceil((expiresAt - Date.now()) / 86400000);
  return { daysLeft, expiresAt };
}

export default function Jira() {
  const [instances, setInstances] = useState({});
  const [loading, setLoading] = useState(true);
  const [editingInstance, setEditingInstance] = useState(null);
  const [testingInstance, setTestingInstance] = useState(null);
  const [testResult, setTestResult] = useState(null);
  const [saveError, setSaveError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState(null);

  // Form state
  const [formData, setFormData] = useState({
    id: '',
    name: '',
    baseUrl: '',
    email: '',
    apiToken: ''
  });

  useEffect(() => {
    loadInstances();
  }, []);

  const loadInstances = async () => {
    try {
      setLoading(true);
      const response = await api.get('/jira/instances');
      setInstances(response.instances || {});
    } catch (error) {
      console.error('Failed to load JIRA instances:', error);
      toast.error(`Failed to load JIRA instances: ${error.message}`);
    } finally {
      setLoading(false);
    }
  };

  const handleEdit = (instance) => {
    setEditingInstance(instance.id);
    setFormData({
      id: instance.id,
      name: instance.name,
      baseUrl: instance.baseUrl,
      email: instance.email,
      apiToken: '' // Don't pre-fill token for security
    });
    setTestResult(null);
    setSaveError(null);
  };

  const handleCreate = () => {
    setEditingInstance('new');
    setFormData({
      id: '',
      name: '',
      baseUrl: '',
      email: '',
      apiToken: ''
    });
    setTestResult(null);
    setSaveError(null);
  };

  const handleCancel = () => {
    setEditingInstance(null);
    setFormData({
      id: '',
      name: '',
      baseUrl: '',
      email: '',
      apiToken: ''
    });
    setTestResult(null);
    setSaveError(null);
  };

  const handleSave = async () => {
    try {
      setSaving(true);
      setSaveError(null);

      const payload = {
        id: formData.id || formData.name.toLowerCase().replace(/\s+/g, '-'),
        name: formData.name,
        baseUrl: formData.baseUrl,
        email: formData.email,
        apiToken: formData.apiToken
      };

      console.log('Saving JIRA instance:', payload);
      await api.post('/jira/instances', payload);

      toast.success(`JIRA instance "${payload.name}" saved successfully`);
      await loadInstances();
      handleCancel();
    } catch (error) {
      console.error('Failed to save JIRA instance:', error);
      setSaveError(error.message);
      toast.error(`Failed to save: ${error.message}`);
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteClick = (instanceId) => {
    setDeleteConfirm(instanceId);
  };

  const handleDeleteConfirm = async () => {
    const instanceId = deleteConfirm;
    setDeleteConfirm(null);

    try {
      await api.delete(`/jira/instances/${instanceId}`);
      toast.success(`JIRA instance "${instanceId}" deleted`);
      await loadInstances();
    } catch (error) {
      console.error('Failed to delete JIRA instance:', error);
      toast.error(`Failed to delete: ${error.message}`);
    }
  };

  const handleDeleteCancel = () => {
    setDeleteConfirm(null);
  };

  const handleTest = async (instanceId) => {
    try {
      setTestingInstance(instanceId);
      setTestResult(null);

      const response = await api.post(`/jira/instances/${instanceId}/test`);
      setTestResult(response);

      if (response.success) {
        toast.success('Connection successful!');
      }
    } catch (error) {
      setTestResult({
        success: false,
        error: error.message
      });
      toast.error(`Connection failed: ${error.message}`);
    } finally {
      setTestingInstance(null);
    }
  };

  const handleInputChange = (e) => {
    setFormData({
      ...formData,
      [e.target.name]: e.target.value
    });
    // Clear error when user starts typing
    if (saveError) {
      setSaveError(null);
    }
  };

  if (loading) {
    return (
      <div className="flex justify-center items-center h-screen">
        <div className="text-gray-400">Loading JIRA instances...</div>
      </div>
    );
  }

  return (
    <div className="p-4 sm:p-6 max-w-6xl mx-auto">
      <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-4 mb-6">
        <h1 className="text-xl sm:text-2xl font-bold text-white">JIRA Integration</h1>
        {!editingInstance && (
          <button
            onClick={handleCreate}
            className="w-full sm:w-auto px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded"
          >
            + Add JIRA Instance
          </button>
        )}
      </div>

      {/* Delete Confirmation Modal */}
      {deleteConfirm && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
          <div className="bg-gray-800 rounded-lg p-4 sm:p-6 max-w-md w-full">
            <h3 className="text-lg sm:text-xl font-bold text-white mb-4">Delete JIRA Instance?</h3>
            <p className="text-gray-300 mb-6 text-sm sm:text-base break-words">
              Are you sure you want to delete "{deleteConfirm}"? This will not affect existing tickets.
            </p>
            <div className="flex flex-col-reverse sm:flex-row gap-2 sm:justify-end">
              <button
                onClick={handleDeleteCancel}
                className="w-full sm:w-auto px-4 py-2 bg-gray-600 hover:bg-gray-700 text-white rounded"
              >
                Cancel
              </button>
              <button
                onClick={handleDeleteConfirm}
                className="w-full sm:w-auto px-4 py-2 bg-red-600 hover:bg-red-700 text-white rounded"
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}

      {editingInstance ? (
        <div className="bg-gray-800 rounded-lg p-4 sm:p-6 mb-6">
          <h2 className="text-lg sm:text-xl font-bold text-white mb-4">
            {editingInstance === 'new' ? 'Add' : 'Edit'} JIRA Instance
          </h2>

          {saveError && (
            <div className="mb-4 p-3 bg-red-900 border border-red-700 rounded">
              <p className="text-red-300 font-medium">Error saving JIRA instance</p>
              <p className="text-red-400 text-sm mt-1">{saveError}</p>
            </div>
          )}

          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-300 mb-1">
                Instance ID
              </label>
              <input
                type="text"
                name="id"
                value={formData.id}
                onChange={handleInputChange}
                disabled={editingInstance !== 'new'}
                className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded text-white disabled:opacity-50"
                placeholder="e.g., company-jira"
              />
              <p className="text-xs text-gray-400 mt-1">
                Unique identifier (cannot be changed after creation)
              </p>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-300 mb-1">
                Display Name
              </label>
              <input
                type="text"
                name="name"
                value={formData.name}
                onChange={handleInputChange}
                className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded text-white"
                placeholder="e.g., Company JIRA"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-300 mb-1">
                Base URL
              </label>
              <input
                type="url"
                name="baseUrl"
                value={formData.baseUrl}
                onChange={handleInputChange}
                className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded text-white"
                placeholder="https://jira.example.com"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-300 mb-1">
                Email
              </label>
              <input
                type="email"
                name="email"
                value={formData.email}
                onChange={handleInputChange}
                className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded text-white"
                placeholder="your.email@example.com"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-300 mb-1">
                API Token (Personal Access Token)
              </label>
              <input
                type="password"
                name="apiToken"
                value={formData.apiToken}
                onChange={handleInputChange}
                className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded text-white"
                placeholder="Enter your JIRA Personal Access Token"
              />
              <p className="text-xs text-gray-400 mt-1">
                Generate this from your JIRA profile → Personal Access Tokens
              </p>
            </div>

            <div className="flex flex-col sm:flex-row gap-2">
              <button
                onClick={handleSave}
                disabled={saving || !formData.name || !formData.baseUrl || !formData.email || !formData.apiToken}
                className="w-full sm:w-auto px-4 py-2 bg-green-600 hover:bg-green-700 text-white rounded disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {saving ? 'Saving...' : 'Save'}
              </button>
              <button
                onClick={handleCancel}
                disabled={saving}
                className="w-full sm:w-auto px-4 py-2 bg-gray-600 hover:bg-gray-700 text-white rounded disabled:opacity-50"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      ) : null}

      <div className="space-y-4">
        {Object.values(instances).length === 0 ? (
          <div className="bg-gray-800 rounded-lg p-8 text-center">
            <p className="text-gray-400">No JIRA instances configured.</p>
            <p className="text-gray-500 text-sm mt-2">
              Add a JIRA instance to enable ticket creation for your apps.
            </p>
          </div>
        ) : (
          Object.values(instances).map((instance) => (
            <div key={instance.id} className="bg-gray-800 rounded-lg p-4 sm:p-6">
              <div className="flex flex-col sm:flex-row sm:justify-between sm:items-start gap-4">
                <div className="flex-1 min-w-0">
                  <h3 className="text-lg font-bold text-white truncate">{instance.name}</h3>
                  <p className="text-gray-400 text-sm mt-1 break-all">{instance.baseUrl}</p>
                  <p className="text-gray-500 text-sm truncate">Email: {instance.email}</p>
                  <p className="text-gray-500 text-sm">
                    API Token: {instance.hasApiToken ? '✓ Configured' : '✗ Not set'}
                  </p>
                  {instance.hasApiToken && (() => {
                    const expiry = getTokenExpiry(instance.tokenUpdatedAt);
                    if (!expiry) return (
                      <p className="text-yellow-400 text-sm mt-1">
                        Token age unknown — re-save to start tracking expiry
                      </p>
                    );
                    if (expiry.daysLeft <= 0) return (
                      <p className="text-red-400 text-sm font-medium mt-1">
                        Token likely expired — regenerate your PAT
                      </p>
                    );
                    if (expiry.daysLeft <= TOKEN_WARN_DAYS) return (
                      <p className="text-yellow-400 text-sm font-medium mt-1">
                        Token expires in {expiry.daysLeft} day{expiry.daysLeft !== 1 ? 's' : ''} — regenerate soon
                      </p>
                    );
                    return null;
                  })()}
                </div>

                <div className="flex flex-wrap gap-2 sm:flex-nowrap">
                  <button
                    onClick={() => handleTest(instance.id)}
                    disabled={testingInstance === instance.id}
                    className="flex-1 sm:flex-none px-3 py-2 sm:py-1 bg-blue-600 hover:bg-blue-700 text-white text-sm rounded disabled:opacity-50"
                  >
                    {testingInstance === instance.id ? 'Testing...' : 'Test'}
                  </button>
                  <button
                    onClick={() => handleEdit(instance)}
                    className="flex-1 sm:flex-none px-3 py-2 sm:py-1 bg-yellow-600 hover:bg-yellow-700 text-white text-sm rounded"
                  >
                    Edit
                  </button>
                  <button
                    onClick={() => handleDeleteClick(instance.id)}
                    className="flex-1 sm:flex-none px-3 py-2 sm:py-1 bg-red-600 hover:bg-red-700 text-white text-sm rounded"
                  >
                    Delete
                  </button>
                </div>
              </div>

              {testResult && testResult.success !== undefined && (
                <div
                  className={`mt-4 p-3 rounded ${
                    testResult.success
                      ? 'bg-green-900 border border-green-700'
                      : 'bg-red-900 border border-red-700'
                  }`}
                >
                  {testResult.success ? (
                    <div>
                      <p className="text-green-300 font-medium">✓ Connection successful</p>
                      <p className="text-green-400 text-sm mt-1">
                        Authenticated as: {testResult.user} ({testResult.email})
                      </p>
                    </div>
                  ) : (
                    <div>
                      <p className="text-red-300 font-medium">✗ Connection failed</p>
                      <p className="text-red-400 text-sm mt-1">{testResult.error}</p>
                    </div>
                  )}
                </div>
              )}
            </div>
          ))
        )}
      </div>

      <div className="mt-6 sm:mt-8 bg-gray-800 rounded-lg p-4 sm:p-6">
        <h2 className="text-base sm:text-lg font-bold text-white mb-3 sm:mb-4">Usage</h2>
        <div className="space-y-2 text-xs sm:text-sm text-gray-300">
          <p>1. Add one or more JIRA instances above</p>
          <p>2. Go to Apps and configure JIRA settings for each app</p>
          <p>
            3. When the Chief of Staff works on an app with JIRA enabled, it will:
          </p>
          <ul className="list-disc list-inside ml-2 sm:ml-4 space-y-1 text-gray-400">
            <li>Create a JIRA ticket for the work</li>
            <li>Create a feature branch (e.g., feature/PROJ-1234)</li>
            <li>Make commits to that branch</li>
            <li>Create a pull request with ticket link</li>
          </ul>
        </div>
      </div>
    </div>
  );
}
