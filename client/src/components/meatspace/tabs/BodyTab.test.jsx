import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

vi.mock('../../../services/api', () => ({
  getBodyHistory: vi.fn(), getBloodPressure: vi.fn(), addBloodPressure: vi.fn(),
  getEyeExams: vi.fn(), addEyeExam: vi.fn(), updateEyeExam: vi.fn(),
}));
vi.mock('../../../hooks/useChartColors.js', () => ({ default: () => ({}) }));
// Charts do not participate in date entry and require browser layout.
vi.mock('recharts', () => ({
  ResponsiveContainer: () => null, LineChart: () => null, Line: () => null,
  XAxis: () => null, YAxis: () => null, CartesianGrid: () => null,
  Tooltip: () => null, Legend: () => null, ReferenceLine: () => null,
}));

import * as api from '../../../services/api';
import BodyTab from './BodyTab';

const EXISTING_EXAM = { id: 'exam-1', date: '2026-02-10', leftSphere: -1 };

beforeEach(() => {
  // At this instant a UTC-7 browser is still on March 14. Scope its calendar
  // getters to this test rather than changing the process-wide TZ environment.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-03-15T00:30:00Z'));
  for (const part of ['FullYear', 'Month', 'Date']) {
    vi.spyOn(Date.prototype, `get${part}`).mockImplementation(function () {
      return new Date(this.getTime() - 7 * 60 * 60 * 1000)[`getUTC${part}`]();
    });
  }
  api.getBodyHistory.mockResolvedValue([]);
  api.getBloodPressure.mockResolvedValue({ readings: [] });
  api.getEyeExams.mockResolvedValue({ exams: [EXISTING_EXAM] });
  api.addBloodPressure.mockImplementation(async input => input);
  api.addEyeExam.mockImplementation(async input => ({ id: 'exam-2', ...input }));
  api.updateEyeExam.mockImplementation(async (id, input) => ({ id, ...input }));
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const changeField = (label, value) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
const click = async name => {
  await act(async () => { fireEvent.click(screen.getByRole('button', { name, exact: true })); });
};

describe('BodyTab measurement dates', () => {
  it('shows and saves the browser-local day for new blood pressure readings and eye exams', async () => {
    await act(async () => { render(<BodyTab />); });
    await click('Add Reading');
    expect(screen.getByLabelText('Date')).toHaveValue('2026-03-14');
    changeField('Systolic', '120');
    changeField('Diastolic', '80');
    await click('Save Reading');
    expect(api.addBloodPressure).toHaveBeenCalledWith({ date: '2026-03-14', systolic: 120, diastolic: 80 });

    await click('Add Exam');
    expect(screen.getByLabelText('Date')).toHaveValue('2026-03-14');
    changeField('L SPH', '-1.25');
    await click('Add');
    expect(api.addEyeExam).toHaveBeenCalledWith({ date: '2026-03-14', leftSphere: -1.25 });
  });

  it('preserves backdated entries and the stored date when editing an existing exam', async () => {
    await act(async () => { render(<BodyTab />); });
    await click('Edit');
    expect(screen.getByLabelText('Date')).toHaveValue(EXISTING_EXAM.date);
    changeField('L SPH', '-1.5');
    await click('Save');
    expect(api.updateEyeExam).toHaveBeenCalledWith('exam-1', { date: '2026-02-10', leftSphere: -1.5 });

    await click('Add Reading');
    changeField('Date', '2026-03-01');
    changeField('Systolic', '118');
    changeField('Diastolic', '78');
    await click('Save Reading');
    expect(api.addBloodPressure).toHaveBeenCalledWith({ date: '2026-03-01', systolic: 118, diastolic: 78 });

    await click('Add Exam');
    changeField('Date', '2026-03-02');
    changeField('R SPH', '-0.75');
    await click('Add');
    expect(api.addEyeExam).toHaveBeenCalledWith({ date: '2026-03-02', rightSphere: -0.75 });
  });
});
