import { Scale } from 'lucide-react';
import * as api from '../../../services/api';
import { VALUES_STATUS } from '../constants';
import TwinEvaluationSuitePanel, { SuiteModelResponses } from './TwinEvaluationSuitePanel';

/**
 * Values-Alignment testing (M34 P6). Poses ethical dilemmas to the embodied
 * twin and grades each answer against the user's ranked values hierarchy.
 * Reuses the provider/model selection from the parent TestTab via the
 * `selectedProviders` prop so the suites share one configuration. Lifecycle +
 * shared presentation live in `TwinEvaluationSuitePanel`; this file only
 * declares the Values suite descriptor and its expanded-detail renderer.
 */
const SUITE = {
  HeaderIcon: Scale,
  title: 'Values-Alignment Tests',
  description: 'Ethical dilemmas scored against your ranked values hierarchy (Identity tab).',
  runLabel: 'Run Dilemmas',
  loadingText: 'Loading values suite',
  itemLabel: 'Dilemma',
  emptyState: (
    <>
      No values-alignment suite found. Add a <span className="text-gray-300">VALUES_ALIGNMENT_SUITE.md</span> to your digital twin folder to enable these tests.
    </>
  ),
  scoreLabel: 'Alignment Score',
  countField: 'aligned',
  historyTitle: 'Recent Values Runs',
  statusMap: VALUES_STATUS,
  passResult: 'aligned',
  failResult: 'misaligned',
  getTests: api.getValuesAlignmentTests,
  getHistory: api.getValuesAlignmentTestHistory,
  runTests: api.runValuesAlignmentTests,
  successToast: 'Values-alignment tests completed'
};

const renderDetail = (dilemma, ctx) => (
  <div className="space-y-4">
    <div>
      <h4 className="text-sm font-medium text-gray-400 mb-1">Scenario</h4>
      <p className="text-white bg-port-card p-3 rounded">{dilemma.scenario}</p>
    </div>
    {dilemma.valuesTested?.length > 0 && (
      <div className="flex flex-wrap gap-2">
        {dilemma.valuesTested.map(v => (
          <span key={v} className="text-xs px-2 py-1 rounded bg-port-accent/20 text-port-accent">
            {v}
          </span>
        ))}
      </div>
    )}
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
      <div>
        <div className="text-port-success text-xs mb-1">Aligned Response</div>
        <div className="text-gray-400 bg-port-card p-3 rounded">{dilemma.alignedResponse}</div>
      </div>
      <div>
        <div className="text-port-error text-xs mb-1">Misaligned Response</div>
        <div className="text-gray-400 bg-port-card p-3 rounded">{dilemma.misalignedResponse}</div>
      </div>
    </div>

    <SuiteModelResponses item={dilemma} label="Response" {...ctx} />
  </div>
);

export default function ValuesAlignmentPanel(props) {
  return <TwinEvaluationSuitePanel suite={SUITE} renderDetail={renderDetail} {...props} />;
}
