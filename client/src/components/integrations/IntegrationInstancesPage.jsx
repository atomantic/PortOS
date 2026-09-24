import { useEffect, useState } from 'react';
import toast from '../ui/Toast';
import { FormField } from '../ui/FormField';
import PageSkeleton from '../ui/PageSkeleton';
import Modal from '../ui/Modal';
import api from '../../services/api';
import { invalidateInstanceFeatures } from '../../hooks/useInstanceFeatures.js';

const inputClass = 'w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded text-white';

export default function IntegrationInstancesPage({
  title, heading, apiBase, feature, fields, initialForm, summarize, testSuccessDetail,
  helpSteps, headerActions, emptyDescription, deleteDescription, skeletonWidth
}) {
  const [instances, setInstances] = useState({});
  const [loading, setLoading] = useState(true);
  const [editingInstance, setEditingInstance] = useState(null);
  const [testingInstance, setTestingInstance] = useState(null);
  const [testResults, setTestResults] = useState({});
  const [saveError, setSaveError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState(null);
  const [formData, setFormData] = useState(initialForm);
  const [customFields, setCustomFields] = useState({});

  useEffect(() => {
    let active = true;
    api.get(`${apiBase}/instances`, { silent: true })
      .then(response => {
        if (active) setInstances(response.instances || {});
      })
      .catch(error => {
        if (!active) return;
        console.error(`❌ Failed to load ${title} instances: ${error.message}`);
        toast.error(`Failed to load ${title} instances: ${error.message}`);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, [apiBase, title]);

  const resetForm = () => {
    setEditingInstance(null);
    setFormData(initialForm);
    setCustomFields({});
    setSaveError(null);
  };

  const handleCreate = () => {
    setFormData(initialForm);
    setCustomFields({});
    setSaveError(null);
    setEditingInstance('new');
  };

  const handleEdit = instance => {
    setFormData({ ...initialForm, ...Object.fromEntries(Object.keys(initialForm)
      .filter(key => !fields.some(field => field.name === key && field.secret))
      .map(key => [key, instance[key] ?? initialForm[key]])) });
    setCustomFields(Object.fromEntries(fields.filter(field => field.options).map(field => [
      field.name, !field.options.some(option => option.value !== 'custom' && option.value === instance[field.name])
    ])));
    setSaveError(null);
    setEditingInstance(instance.id);
  };

  const handleInputChange = event => {
    const { name, value } = event.target;
    setFormData(previous => ({ ...previous, [name]: value }));
    setSaveError(null);
  };

  const handleSave = async () => {
    setSaving(true);
    setSaveError(null);
    const payload = {
      ...formData,
      id: formData.id || formData.name.toLowerCase().replace(/\s+/g, '-'),
      ...Object.fromEntries(fields.filter(field => field.secret && !formData[field.name]).map(field => [field.name, undefined]))
    };
    try {
      const saved = await api.post(`${apiBase}/instances`, payload, { silent: true });
      invalidateInstanceFeatures(feature);
      toast.success(`${title} instance "${payload.name}" saved successfully`);
      setInstances(previous => ({ ...previous, [saved.id]: saved }));
      resetForm();
    } catch (error) {
      console.error(`❌ Failed to save ${title} instance: ${error.message}`);
      setSaveError(error.message);
      toast.error(`Failed to save: ${error.message}`);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    const instanceId = deleteConfirm;
    setDeleteConfirm(null);
    try {
      await api.delete(`${apiBase}/instances/${instanceId}`, { silent: true });
      invalidateInstanceFeatures(feature);
      toast.success(`${title} instance "${instanceId}" deleted`);
      setInstances(previous => {
        const next = { ...previous };
        delete next[instanceId];
        return next;
      });
      setTestResults(previous => {
        const next = { ...previous };
        delete next[instanceId];
        return next;
      });
    } catch (error) {
      console.error(`❌ Failed to delete ${title} instance: ${error.message}`);
      toast.error(`Failed to delete: ${error.message}`);
    }
  };

  const handleTest = async instanceId => {
    setTestingInstance(instanceId);
    setTestResults(previous => ({ ...previous, [instanceId]: null }));
    try {
      const result = await api.post(`${apiBase}/instances/${instanceId}/test`, undefined, { silent: true });
      setTestResults(previous => ({ ...previous, [instanceId]: result }));
      if (result.success) toast.success('Connection successful!');
    } catch (error) {
      setTestResults(previous => ({ ...previous, [instanceId]: { success: false, error: error.message } }));
      toast.error(`Connection failed: ${error.message}`);
    } finally {
      setTestingInstance(null);
    }
  };

  if (loading) return <PageSkeleton label={`Loading ${title}`} padded titleWidthClass={skeletonWidth} cards={2} />;

  return (
    <div className="@container/page min-w-0 p-4 sm:p-6">
      <div className="flex flex-wrap justify-between items-center gap-4 mb-6">
        {heading}
        <div className="flex flex-wrap items-center gap-2">
          {headerActions}
          {!editingInstance && <button onClick={handleCreate} className="max-w-full w-full @sm/page:w-auto px-4 py-2 bg-port-accent hover:bg-port-accent/80 text-white rounded">+ Add {title} Instance</button>}
        </div>
      </div>

      <Modal open={!!deleteConfirm} onClose={() => setDeleteConfirm(null)} size="sm" backdropClassName="bg-black/50" ariaLabelledBy={`${feature}-delete-title`}>
        <div className="bg-gray-800 rounded-lg p-4 sm:p-6">
          <h3 id={`${feature}-delete-title`} className="text-lg sm:text-xl font-bold text-white mb-4">Delete {title} Instance?</h3>
          <p className="text-gray-300 mb-6 text-sm sm:text-base break-words">Are you sure you want to delete &quot;{deleteConfirm}&quot;? {deleteDescription}</p>
          <div className="flex flex-col-reverse sm:flex-row gap-2 sm:justify-end">
            <button onClick={() => setDeleteConfirm(null)} className="max-w-full w-full @sm/page:w-auto px-4 py-2 bg-gray-600 hover:bg-gray-700 text-white rounded">Cancel</button>
            <button onClick={handleDelete} className="max-w-full w-full @sm/page:w-auto px-4 py-2 bg-port-error hover:bg-port-error/80 text-white rounded">Delete</button>
          </div>
        </div>
      </Modal>

      <div className="grid grid-cols-1 @5xl/page:grid-cols-[minmax(0,1fr)_360px] gap-6 items-start">
        {editingInstance && <div className="bg-gray-800 rounded-lg p-4 sm:p-6 min-w-0">
          <h2 className="text-lg sm:text-xl font-bold text-white mb-4">{editingInstance === 'new' ? 'Add' : 'Edit'} {title} Instance</h2>
          {saveError && <div role="alert" className="mb-4 p-3 bg-port-error/20 border border-port-error/40 rounded">
            <p className="text-port-error font-medium">Error saving {title} instance</p>
            <p className="text-port-error/80 text-sm mt-1">{saveError}</p>
          </div>}
          <div className="space-y-4">
            <FormField label="Instance ID" labelClassName="block text-sm font-medium text-gray-300 mb-1">
              <input type="text" name="id" value={formData.id} onChange={handleInputChange} disabled={editingInstance !== 'new'} className={`${inputClass} disabled:opacity-50`} placeholder={`e.g., company-${feature}`} />
              <p className="text-xs text-gray-400 mt-1">Unique identifier (cannot be changed after creation)</p>
            </FormField>
            <FormField label="Display Name" labelClassName="block text-sm font-medium text-gray-300 mb-1">
              <input type="text" name="name" value={formData.name} onChange={handleInputChange} className={inputClass} placeholder={`e.g., Company ${title}`} />
            </FormField>
            {fields.map(field => <FormField key={field.name} label={field.label} labelClassName="block text-sm font-medium text-gray-300 mb-1">
              {field.options ? <select value={customFields[field.name] ? 'custom' : formData[field.name]} onChange={event => {
                  const isCustom = event.target.value === 'custom';
                  setCustomFields(previous => ({ ...previous, [field.name]: isCustom }));
                  setFormData(previous => ({ ...previous, [field.name]: isCustom ? '' : event.target.value }));
                }} className={`${inputClass} mb-2`}>
                  {field.options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
                </select> : <input type={field.type || 'text'} name={field.name} value={formData[field.name]} onChange={handleInputChange} className={inputClass} placeholder={field.secret && editingInstance !== 'new' ? 'Leave blank to keep existing key' : field.placeholder} />}
              {field.options && customFields[field.name] && <input type="text" name={field.name} value={formData[field.name]} onChange={handleInputChange} aria-label={`Custom ${field.label.toLowerCase()}`} className={inputClass} placeholder={field.customPlaceholder} />}
              {field.help && <p className="text-xs text-gray-400 mt-1">{field.help}</p>}
            </FormField>)}
            <div className="flex flex-col sm:flex-row gap-2">
              <button onClick={handleSave} disabled={saving || !formData.name || fields.some(field => !field.secret && !formData[field.name] || field.secret && editingInstance === 'new' && !formData[field.name])} className="max-w-full w-full @sm/page:w-auto px-4 py-2 bg-port-success hover:bg-port-success/80 text-white rounded disabled:opacity-50 disabled:cursor-not-allowed">{saving ? 'Saving...' : 'Save'}</button>
              <button onClick={resetForm} disabled={saving} className="max-w-full w-full @sm/page:w-auto px-4 py-2 bg-gray-600 hover:bg-gray-700 text-white rounded disabled:opacity-50">Cancel</button>
            </div>
          </div>
        </div>}

        <div className="space-y-4 @5xl/page:col-start-2 @5xl/page:row-start-1">
          {Object.values(instances).length === 0 ? <div className="bg-gray-800 rounded-lg p-8 text-center">
            <p className="text-gray-400">No {title} instances configured.</p>
            <p className="text-gray-500 text-sm mt-2">{emptyDescription}</p>
          </div> : Object.values(instances).map(instance => {
            const result = testResults[instance.id];
            return <div key={instance.id} className="bg-gray-800 rounded-lg p-4 sm:p-6">
              <div className="flex flex-col gap-4">
                <div className="flex-1 min-w-0"><h3 className="text-lg font-bold text-white truncate">{instance.name}</h3>{summarize(instance)}</div>
                <div className="flex flex-wrap gap-2">
                  <button onClick={() => handleTest(instance.id)} disabled={testingInstance === instance.id} className="flex-1 sm:flex-none px-3 py-2 sm:py-1 bg-port-accent hover:bg-port-accent/80 text-white text-sm rounded disabled:opacity-50">{testingInstance === instance.id ? 'Testing...' : 'Test'}</button>
                  <button onClick={() => handleEdit(instance)} className="flex-1 sm:flex-none px-3 py-2 sm:py-1 bg-port-warning hover:bg-port-warning/80 text-white text-sm rounded">Edit</button>
                  <button onClick={() => setDeleteConfirm(instance.id)} className="flex-1 sm:flex-none px-3 py-2 sm:py-1 bg-port-error hover:bg-port-error/80 text-white text-sm rounded">Delete</button>
                </div>
              </div>
              {result && result.success !== undefined && <div className={`mt-4 p-3 rounded ${result.success ? 'bg-port-success/20 border border-port-success/40' : 'bg-port-error/20 border border-port-error/40'}`}>
                {result.success ? testSuccessDetail(result) : <><p className="text-port-error font-medium">{title === 'JIRA' ? '✗ ' : ''}Connection failed</p><p className="text-port-error/80 text-sm mt-1">{result.error}</p></>}
              </div>}
            </div>;
          })}
        </div>
        <div className="bg-gray-800 rounded-lg p-4 sm:p-6 min-w-0">
          <h2 className="text-base sm:text-lg font-bold text-white mb-3 sm:mb-4">Usage</h2>
          <div className="space-y-2 text-xs sm:text-sm text-gray-300">{helpSteps}</div>
        </div>
      </div>
    </div>
  );
}
