import { useState, useEffect, useCallback } from 'react';
import { HeartPulse, Eye, Dna, Scale, Plus, Pencil, Trash2, Check, X } from 'lucide-react';
import * as api from '../../../services/api';
import BrailleSpinner from '../../BrailleSpinner';
import BloodTestCard from '../BloodTestCard';
import BodyCompChart from '../BodyCompChart';

const EMPTY_EYE_FORM = {
  date: '', leftSphere: '', leftCylinder: '', leftAxis: '',
  rightSphere: '', rightCylinder: '', rightAxis: ''
};

function formatSph(val) {
  if (val == null) return '—';
  return (val > 0 ? '+' : '') + val.toFixed(2);
}

export default function BloodTab() {
  const [bloodData, setBloodData] = useState(null);
  const [epigeneticData, setEpigeneticData] = useState(null);
  const [eyeData, setEyeData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshKey, setRefreshKey] = useState(0);
  const [showEyeForm, setShowEyeForm] = useState(false);
  const [eyeForm, setEyeForm] = useState(EMPTY_EYE_FORM);
  const [editingEyeIdx, setEditingEyeIdx] = useState(null);

  const fetchData = useCallback(async () => {
    const [blood, epigenetic, eyes] = await Promise.all([
      api.getBloodTests().catch(() => ({ tests: [] })),
      api.getEpigeneticTests().catch(() => ({ tests: [] })),
      api.getEyeExams().catch(() => ({ exams: [] }))
    ]);
    setBloodData(blood);
    setEpigeneticData(epigenetic);
    setEyeData(eyes);
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData, refreshKey]);

  const parseNum = (v) => {
    if (v === '' || v === null || v === undefined) return null;
    const n = parseFloat(v);
    return isNaN(n) ? null : n;
  };

  const buildEyePayload = (form) => {
    const payload = { date: form.date };
    for (const key of ['leftSphere', 'leftCylinder', 'leftAxis', 'rightSphere', 'rightCylinder', 'rightAxis']) {
      const v = parseNum(form[key]);
      if (v !== null) payload[key] = v;
    }
    return payload;
  };

  const handleAddEye = async () => {
    if (!eyeForm.date) return;
    await api.addEyeExam(buildEyePayload(eyeForm));
    setEyeForm(EMPTY_EYE_FORM);
    setShowEyeForm(false);
    setRefreshKey(k => k + 1);
  };

  const startEditEye = (exam, idx) => {
    setEditingEyeIdx(idx);
    setEyeForm({
      date: exam.date,
      leftSphere: exam.leftSphere ?? '',
      leftCylinder: exam.leftCylinder ?? '',
      leftAxis: exam.leftAxis ?? '',
      rightSphere: exam.rightSphere ?? '',
      rightCylinder: exam.rightCylinder ?? '',
      rightAxis: exam.rightAxis ?? ''
    });
  };

  const handleUpdateEye = async () => {
    if (editingEyeIdx == null) return;
    await api.updateEyeExam(editingEyeIdx, buildEyePayload(eyeForm));
    setEditingEyeIdx(null);
    setEyeForm(EMPTY_EYE_FORM);
    setRefreshKey(k => k + 1);
  };

  const handleDeleteEye = async (idx) => {
    await api.removeEyeExam(idx);
    setRefreshKey(k => k + 1);
  };

  if (loading) {
    return (
      <div className="flex justify-center py-12">
        <BrailleSpinner text="Loading health data" />
      </div>
    );
  }

  const bloodTests = bloodData?.tests || [];
  const epigeneticTests = epigeneticData?.tests || [];
  const eyeExams = eyeData?.exams || [];
  const latestEpigenetic = epigeneticTests[epigeneticTests.length - 1];

  return (
    <div className="space-y-6">
      {/* Epigenetic Age Summary */}
      {latestEpigenetic && (
        <div className="bg-port-card border border-port-border rounded-xl p-6">
          <div className="flex items-center gap-2 mb-4">
            <Dna size={18} className="text-purple-400" />
            <h3 className="text-sm font-medium text-gray-400 uppercase tracking-wider">Epigenetic Age</h3>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div>
              <p className="text-xs text-gray-500 uppercase">Chronological</p>
              <p className="text-2xl font-mono font-bold text-gray-300">{latestEpigenetic.chronologicalAge}</p>
            </div>
            <div>
              <p className="text-xs text-gray-500 uppercase">Biological</p>
              <p className={`text-2xl font-mono font-bold ${
                latestEpigenetic.biologicalAge < latestEpigenetic.chronologicalAge
                  ? 'text-port-success' : 'text-port-error'
              }`}>
                {latestEpigenetic.biologicalAge}
              </p>
            </div>
            <div>
              <p className="text-xs text-gray-500 uppercase">Pace of Aging</p>
              <p className={`text-2xl font-mono font-bold ${
                latestEpigenetic.paceOfAging < 1 ? 'text-port-success' : 'text-port-error'
              }`}>
                {latestEpigenetic.paceOfAging}
              </p>
            </div>
            <div>
              <p className="text-xs text-gray-500 uppercase">Test Date</p>
              <p className="text-lg font-mono text-gray-400">{latestEpigenetic.date}</p>
            </div>
          </div>

          {/* Organ Scores */}
          {latestEpigenetic.organScores && (
            <div className="mt-4 pt-4 border-t border-port-border">
              <p className="text-xs text-gray-500 uppercase mb-2">Organ Scores (biological age)</p>
              <div className="grid grid-cols-3 md:grid-cols-5 gap-2">
                {Object.entries(latestEpigenetic.organScores).map(([organ, age]) => (
                  <div key={organ} className="flex items-baseline justify-between gap-2 px-2 py-1 rounded bg-port-bg/50">
                    <span className="text-xs text-gray-400 capitalize">{organ}</span>
                    <span className={`text-sm font-mono font-medium ${
                      age < latestEpigenetic.chronologicalAge ? 'text-port-success' : 'text-port-error'
                    }`}>
                      {age}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* History */}
          {epigeneticTests.length > 1 && (
            <div className="mt-4 pt-4 border-t border-port-border">
              <p className="text-xs text-gray-500 uppercase mb-2">History</p>
              <div className="space-y-1">
                {epigeneticTests.map((test, i) => (
                  <div key={i} className="flex items-center gap-4 text-sm">
                    <span className="text-gray-500 font-mono w-24">{test.date}</span>
                    <span className="text-gray-400">Bio: {test.biologicalAge}</span>
                    <span className="text-gray-400">Pace: {test.paceOfAging}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Body Composition Chart */}
      <div>
        <div className="flex items-center gap-2 mb-3">
          <Scale size={18} className="text-port-accent" />
          <h3 className="text-sm font-medium text-gray-400 uppercase tracking-wider">Body Composition</h3>
        </div>
        <BodyCompChart />
      </div>

      {/* Blood Tests */}
      <div>
        <div className="flex items-center gap-2 mb-3">
          <HeartPulse size={18} className="text-red-400" />
          <h3 className="text-sm font-medium text-gray-400 uppercase tracking-wider">
            Blood Tests ({bloodTests.length})
          </h3>
        </div>
        {bloodTests.length === 0 ? (
          <div className="bg-port-card border border-port-border rounded-xl p-6">
            <p className="text-gray-500 text-sm">No blood test data. Import your health spreadsheet or add tests manually.</p>
          </div>
        ) : (
          <div className="space-y-4">
            {[...bloodTests].reverse().map((test, i) => (
              <BloodTestCard key={i} test={test} />
            ))}
          </div>
        )}
      </div>

      {/* Eye Exams */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <Eye size={18} className="text-blue-400" />
            <h3 className="text-sm font-medium text-gray-400 uppercase tracking-wider">
              Eye Prescriptions ({eyeExams.length})
            </h3>
          </div>
          {!showEyeForm && editingEyeIdx == null && (
            <button
              onClick={() => { setShowEyeForm(true); setEyeForm({ ...EMPTY_EYE_FORM, date: new Date().toISOString().split('T')[0] }); }}
              className="flex items-center gap-1 text-xs text-port-accent hover:text-blue-300 transition-colors"
            >
              <Plus size={14} /> Add Exam
            </button>
          )}
        </div>

        {/* Add / Edit Form */}
        {(showEyeForm || editingEyeIdx != null) && (
          <div className="bg-port-card border border-port-border rounded-xl p-4 mb-3">
            <h4 className="text-sm font-medium text-gray-300 mb-3">
              {editingEyeIdx != null ? 'Edit Eye Exam' : 'New Eye Exam'}
            </h4>
            <div className="grid grid-cols-7 gap-2 mb-3">
              <div>
                <label className="text-xs text-gray-500">Date</label>
                <input type="date" value={eyeForm.date}
                  onChange={e => setEyeForm(f => ({ ...f, date: e.target.value }))}
                  className="w-full bg-port-bg border border-port-border rounded px-2 py-1 text-sm text-gray-200 font-mono" />
              </div>
              <div>
                <label className="text-xs text-gray-500">L SPH</label>
                <input type="number" step="0.25" value={eyeForm.leftSphere}
                  onChange={e => setEyeForm(f => ({ ...f, leftSphere: e.target.value }))}
                  className="w-full bg-port-bg border border-port-border rounded px-2 py-1 text-sm text-gray-200 font-mono" />
              </div>
              <div>
                <label className="text-xs text-gray-500">L CYL</label>
                <input type="number" step="0.25" value={eyeForm.leftCylinder}
                  onChange={e => setEyeForm(f => ({ ...f, leftCylinder: e.target.value }))}
                  className="w-full bg-port-bg border border-port-border rounded px-2 py-1 text-sm text-gray-200 font-mono" />
              </div>
              <div>
                <label className="text-xs text-gray-500">L AXIS</label>
                <input type="number" step="1" min="0" max="180" value={eyeForm.leftAxis}
                  onChange={e => setEyeForm(f => ({ ...f, leftAxis: e.target.value }))}
                  className="w-full bg-port-bg border border-port-border rounded px-2 py-1 text-sm text-gray-200 font-mono" />
              </div>
              <div>
                <label className="text-xs text-gray-500">R SPH</label>
                <input type="number" step="0.25" value={eyeForm.rightSphere}
                  onChange={e => setEyeForm(f => ({ ...f, rightSphere: e.target.value }))}
                  className="w-full bg-port-bg border border-port-border rounded px-2 py-1 text-sm text-gray-200 font-mono" />
              </div>
              <div>
                <label className="text-xs text-gray-500">R CYL</label>
                <input type="number" step="0.25" value={eyeForm.rightCylinder}
                  onChange={e => setEyeForm(f => ({ ...f, rightCylinder: e.target.value }))}
                  className="w-full bg-port-bg border border-port-border rounded px-2 py-1 text-sm text-gray-200 font-mono" />
              </div>
              <div>
                <label className="text-xs text-gray-500">R AXIS</label>
                <input type="number" step="1" min="0" max="180" value={eyeForm.rightAxis}
                  onChange={e => setEyeForm(f => ({ ...f, rightAxis: e.target.value }))}
                  className="w-full bg-port-bg border border-port-border rounded px-2 py-1 text-sm text-gray-200 font-mono" />
              </div>
            </div>
            <div className="flex gap-2">
              <button
                onClick={editingEyeIdx != null ? handleUpdateEye : handleAddEye}
                disabled={!eyeForm.date}
                className="flex items-center gap-1 px-3 py-1 bg-port-accent/20 text-port-accent rounded text-sm hover:bg-port-accent/30 disabled:opacity-40"
              >
                <Check size={14} /> {editingEyeIdx != null ? 'Save' : 'Add'}
              </button>
              <button
                onClick={() => { setShowEyeForm(false); setEditingEyeIdx(null); setEyeForm(EMPTY_EYE_FORM); }}
                className="flex items-center gap-1 px-3 py-1 text-gray-400 hover:text-gray-200 text-sm"
              >
                <X size={14} /> Cancel
              </button>
            </div>
          </div>
        )}

        {eyeExams.length === 0 ? (
          <div className="bg-port-card border border-port-border rounded-xl p-6">
            <p className="text-gray-500 text-sm">No eye exam data. Import your health spreadsheet or add exams manually.</p>
          </div>
        ) : (
          <div className="bg-port-card border border-port-border rounded-xl overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs text-gray-500 uppercase border-b border-port-border">
                  <th className="text-left py-2 px-3">Date</th>
                  <th className="text-right py-2 px-2">L SPH</th>
                  <th className="text-right py-2 px-2">L CYL</th>
                  <th className="text-right py-2 px-2">L AXIS</th>
                  <th className="text-right py-2 px-2">R SPH</th>
                  <th className="text-right py-2 px-2">R CYL</th>
                  <th className="text-right py-2 px-2">R AXIS</th>
                  <th className="w-16"></th>
                </tr>
              </thead>
              <tbody>
                {[...eyeExams].reverse().map((exam, revIdx) => {
                  const realIdx = eyeExams.length - 1 - revIdx;
                  return (
                    <tr key={realIdx} className="border-b border-port-border/50 hover:bg-port-bg/30">
                      <td className="py-1.5 px-3 font-mono text-gray-400">{exam.date}</td>
                      <td className="py-1.5 px-2 text-right font-mono text-gray-300">{formatSph(exam.leftSphere)}</td>
                      <td className="py-1.5 px-2 text-right font-mono text-gray-300">{formatSph(exam.leftCylinder)}</td>
                      <td className="py-1.5 px-2 text-right font-mono text-gray-300">{exam.leftAxis != null ? `${exam.leftAxis}°` : '—'}</td>
                      <td className="py-1.5 px-2 text-right font-mono text-gray-300">{formatSph(exam.rightSphere)}</td>
                      <td className="py-1.5 px-2 text-right font-mono text-gray-300">{formatSph(exam.rightCylinder)}</td>
                      <td className="py-1.5 px-2 text-right font-mono text-gray-300">{exam.rightAxis != null ? `${exam.rightAxis}°` : '—'}</td>
                      <td className="py-1.5 px-2 text-right">
                        <div className="flex items-center justify-end gap-1">
                          <button
                            onClick={() => startEditEye(exam, realIdx)}
                            className="p-1 text-gray-600 hover:text-port-accent transition-colors"
                            title="Edit"
                          >
                            <Pencil size={12} />
                          </button>
                          <button
                            onClick={() => handleDeleteEye(realIdx)}
                            className="p-1 text-gray-600 hover:text-port-error transition-colors"
                            title="Delete"
                          >
                            <Trash2 size={12} />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
