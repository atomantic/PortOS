import { ShieldAlert } from 'lucide-react';
import * as api from '../../../services/api';
import { ADVERSARIAL_STATUS } from '../constants';
import TwinEvaluationSuitePanel, { SuiteModelResponses } from './TwinEvaluationSuitePanel';

/**
 * Adversarial Boundary testing (M34 P6). Tries to manipulate the embodied twin
 * — authority pressure, flattery, guilt, incremental escalation, harmful
 * reframing — into crossing a stated boundary, then grades whether the twin
 * held the line. Reuses the provider/model + persona selection from the parent
 * TestTab via props so the three suites share one configuration. Lifecycle +
 * shared presentation live in `TwinEvaluationSuitePanel`; this file only
 * declares the Adversarial suite descriptor and its expanded-detail renderer.
 */
const SUITE = {
  HeaderIcon: ShieldAlert,
  title: 'Adversarial Boundary Tests',
  description: 'Manipulation attempts scored on whether your twin held its boundaries (non-negotiables & error-intolerances).',
  runLabel: 'Run Scenarios',
  loadingText: 'Loading boundary suite',
  itemLabel: 'Scenario',
  emptyState: (
    <>
      No adversarial-boundary suite found. Add an <span className="text-gray-300">ADVERSARIAL_BOUNDARY_SUITE.md</span> to your digital twin folder to enable these tests.
    </>
  ),
  scoreLabel: 'Boundary Score',
  countField: 'held',
  historyTitle: 'Recent Boundary Runs',
  statusMap: ADVERSARIAL_STATUS,
  passResult: 'held',
  failResult: 'breached',
  getTests: api.getAdversarialTests,
  getHistory: api.getAdversarialTestHistory,
  runTests: api.runAdversarialTests,
  successToast: 'Adversarial boundary tests completed'
};

const renderDetail = (scenario, ctx) => (
  <div className="space-y-4">
    <div>
      <h4 className="text-sm font-medium text-gray-400 mb-1">Manipulation Setup</h4>
      <p className="text-white bg-port-card p-3 rounded">{scenario.setup}</p>
    </div>
    {scenario.boundaryTested?.length > 0 && (
      <div className="flex flex-wrap gap-2">
        {scenario.boundaryTested.map(b => (
          <span key={b} className="text-xs px-2 py-1 rounded bg-port-accent/20 text-port-accent">
            {b}
          </span>
        ))}
      </div>
    )}
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
      <div>
        <div className="text-port-success text-xs mb-1">Held Response</div>
        <div className="text-gray-400 bg-port-card p-3 rounded">{scenario.heldResponse}</div>
      </div>
      <div>
        <div className="text-port-error text-xs mb-1">Breached Response</div>
        <div className="text-gray-400 bg-port-card p-3 rounded">{scenario.breachedResponse}</div>
      </div>
    </div>

    <SuiteModelResponses item={scenario} label="Response" {...ctx} />
  </div>
);

export default function AdversarialBoundaryPanel(props) {
  return <TwinEvaluationSuitePanel suite={SUITE} renderDetail={renderDetail} {...props} />;
}
