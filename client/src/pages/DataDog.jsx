import { useState, useEffect } from 'react';
import toast from 'react-hot-toast';
import api from '../services/api';

const SITE_OPTIONS = [
  { value: 'api.datadoghq.com', label: 'US1 (api.datadoghq.com)' },
  { value: 'api.datadoghq.eu', label: 'EU (api.datadoghq.eu)' },
  { value: 'api.us3.datadoghq.com', label: 'US3 (api.us3.datadoghq.com)' },
  { value: 'api.us5.datadoghq.com', label: 'US5 (api.us5.datadoghq.com)' },
  { value: 'api.ap1.datadoghq.com', label: 'AP1 (api.ap1.datadoghq.com)' },
  { value: 'custom', label: 'Custom...' }
];

export default function DataDog() {
  const [instances, setInstances] = useState({});
  const [loading, setLoading] = useState(true);
  const [editingInstance, setEditingInstance] = useState(null);
  const [testingInstance, setTestingInstance] = useState(null);
  const [testResults, setTestResults] = useState({});
  const [saveError, setSaveError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState(null);
  const [customSite, setCustomSite] = useState(false);

  const [formData, setFormData] = useState({
    id: '',
    name: '',
    site: 'api.datadoghq.com',
    apiKey: '',
    appKey: ''
  });

  useEffect(() => {
    loadInstances();
  }, []);

  const loadInstances = async () => {
    try {
      setLoading(true);
      const response = await api.get('/datadog/instances');
      setInstances(response.instances || {});
    } catch (error) {
      console.error(`Failed to load DataDog instances: ${error.message}`);
      toast.error(`Failed to load DataDog instances: ${error.message}`);
    } finally {
      setLoading(false);
    }
  };

  const handleEdit = (instance) => {
    setEditingInstance(instance.id);
    const isCustom = !SITE_OPTIONS.some(o => o.value !== 'custom' && o.value === instance.site);
    setCustomSite(isCustom);
    setFormData({
      id: instance.id,
      name: instance.name,
      site: isCustom ? instance.site : instance.site,
      apiKey: '',
      appKey: ''
    });
    setSaveError(null);
  };

  const handleCreate = () => {
    setEditingInstance('new');
    setCustomSite(false);
    setFormData({
      id: '',
      name: '',
      site: 'api.datadoghq.com',
      apiKey: '',
      appKey: ''
    });
    setSaveError(null);
  };

  const handleCancel = () => {
    setEditingInstance(null);
    setCustomSite(false);
    setFormData({
      id: '',
      name: '',
      site: 'api.datadoghq.com',
      apiKey: '',
      appKey: ''
    });
    setSaveError(null);
  };

  const handleSave = async () => {
    try {
      setSaving(true);
      setSaveError(null);

      const payload = {
        id: formData.id || formData.name.toLowerCase().replace(/\s+/g, '-'),
        name: formData.name,
        site: formData.site,
        apiKey: formData.apiKey,
        appKey: formData.appKey
      };

      await api.post('/datadog/instances', payload);

      toast.success(`DataDog instance "${payload.name}" saved successfully`);
      await loadInstances();
      handleCancel();
    } catch (error) {
      console.error(`Failed to save DataDog instance: ${error.message}`);
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
      await api.delete(`/datadog/instances/${instanceId}`);
      toast.success(`DataDog instance "${instanceId}" deleted`);
      await loadInstances();
    } catch (error) {
      console.error(`Failed to delete DataDog instance: ${error.message}`);
      toast.error(`Failed to delete: ${error.message}`);
    }
  };

  const handleDeleteCancel = () => {
    setDeleteConfirm(null);
  };

  const handleTest = async (instanceId) => {
    try {
      setTestingInstance(instanceId);
      setTestResults(prev => ({ ...prev, [instanceId]: null }));

      const response = await api.post(`/datadog/instances/${instanceId}/test`);
      setTestResults(prev => ({ ...prev, [instanceId]: response }));

      if (response.success) {
        toast.success('Connection successful!');
      }
    } catch (error) {
      setTestResults(prev => ({ ...prev, [instanceId]: { success: false, error: error.message } }));
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
    if (saveError) {
      setSaveError(null);
    }
  };

  const handleSiteChange = (e) => {
    const value = e.target.value;
    if (value === 'custom') {
      setCustomSite(true);
      setFormData({ ...formData, site: '' });
    } else {
      setCustomSite(false);
      setFormData({ ...formData, site: value });
    }
  };

  if (loading) {
    return (
      <div className="flex justify-center items-center h-screen">
        <div className="text-gray-400">Loading DataDog instances...</div>
      </div>
    );
  }

  return (
    <div className="p-4 sm:p-6 max-w-6xl mx-auto">
      <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-4 mb-6">
        <h1 className="text-xl sm:text-2xl font-bold text-white">DataDog Integration</h1>
        {!editingInstance && (
          <button
            onClick={handleCreate}
            className="w-full sm:w-auto px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded"
          >
            + Add DataDog Instance
          </button>
        )}
      </div>

      {/* Delete Confirmation Modal */}
      {deleteConfirm && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
          <div className="bg-gray-800 rounded-lg p-4 sm:p-6 max-w-md w-full">
            <h3 className="text-lg sm:text-xl font-bold text-white mb-4">Delete DataDog Instance?</h3>
            <p className="text-gray-300 mb-6 text-sm sm:text-base break-words">
              Are you sure you want to delete &quot;{deleteConfirm}&quot;? This will remove the stored keys.
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
            {editingInstance === 'new' ? 'Add' : 'Edit'} DataDog Instance
          </h2>

          {saveError && (
            <div className="mb-4 p-3 bg-red-900 border border-red-700 rounded">
              <p className="text-red-300 font-medium">Error saving DataDog instance</p>
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
                placeholder="e.g., company-datadog"
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
                placeholder="e.g., Company DataDog"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-300 mb-1">
                Site
              </label>
              <select
                value={customSite ? 'custom' : formData.site}
                onChange={handleSiteChange}
                className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded text-white mb-2"
              >
                {SITE_OPTIONS.map(opt => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>
              {customSite && (
                <input
                  type="text"
                  name="site"
                  value={formData.site}
                  onChange={handleInputChange}
                  className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded text-white"
                  placeholder="e.g., api.custom-datadog.com"
                />
              )}
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-300 mb-1">
                API Key
              </label>
              <input
                type="password"
                name="apiKey"
                value={formData.apiKey}
                onChange={handleInputChange}
                className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded text-white"
                placeholder="Enter your DataDog API Key"
              />
              <p className="text-xs text-gray-400 mt-1">
                Found in DataDog Organization Settings &rarr; API Keys
              </p>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-300 mb-1">
                Application Key
              </label>
              <input
                type="password"
                name="appKey"
                value={formData.appKey}
                onChange={handleInputChange}
                className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded text-white"
                placeholder="Enter your DataDog Application Key"
              />
              <p className="text-xs text-gray-400 mt-1">
                Found in DataDog Organization Settings &rarr; Application Keys
              </p>
            </div>

            <div className="flex flex-col sm:flex-row gap-2">
              <button
                onClick={handleSave}
                disabled={saving || !formData.name || !formData.site || !formData.apiKey || !formData.appKey}
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
            <p className="text-gray-400">No DataDog instances configured.</p>
            <p className="text-gray-500 text-sm mt-2">
              Add a DataDog instance to enable error monitoring for your apps.
            </p>
          </div>
        ) : (
          Object.values(instances).map((instance) => (
            <div key={instance.id} className="bg-gray-800 rounded-lg p-4 sm:p-6">
              <div className="flex flex-col sm:flex-row sm:justify-between sm:items-start gap-4">
                <div className="flex-1 min-w-0">
                  <h3 className="text-lg font-bold text-white truncate">{instance.name}</h3>
                  <p className="text-gray-400 text-sm mt-1 break-all">Site: {instance.site}</p>
                  <p className="text-gray-500 text-sm">
                    API Key: {instance.hasApiKey ? 'Configured' : 'Not set'}
                  </p>
                  <p className="text-gray-500 text-sm">
                    App Key: {instance.hasAppKey ? 'Configured' : 'Not set'}
                  </p>
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

              {testResults[instance.id] && testResults[instance.id].success !== undefined && (
                <div
                  className={`mt-4 p-3 rounded ${
                    testResults[instance.id].success
                      ? 'bg-green-900 border border-green-700'
                      : 'bg-red-900 border border-red-700'
                  }`}
                >
                  {testResults[instance.id].success ? (
                    <p className="text-green-300 font-medium">API key validated</p>
                  ) : (
                    <>
                      <p className="text-red-300 font-medium">Connection failed</p>
                      <p className="text-red-400 text-sm mt-1">{testResults[instance.id].error}</p>
                    </>
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
          <p>1. Add one or more DataDog instances above</p>
          <p>2. Go to Apps and enable DataDog monitoring in each app&apos;s settings</p>
          <p>3. The error monitor job will periodically check for new errors:</p>
          <ul className="list-disc list-inside ml-2 sm:ml-4 space-y-1 text-gray-400">
            <li>Query DataDog for recent error events matching the app&apos;s service name</li>
            <li>Surface new errors in notifications and app insights</li>
            <li>Track error trends over time</li>
          </ul>
        </div>
      </div>
    </div>
  );
}
