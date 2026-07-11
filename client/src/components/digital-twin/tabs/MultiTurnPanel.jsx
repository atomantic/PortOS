import { MessagesSquare } from 'lucide-react';
import * as api from '../../../services/api';
import { MULTI_TURN_STATUS } from '../constants';
import TwinEvaluationSuitePanel, { SuiteModelResponses } from './TwinEvaluationSuitePanel';

/**
 * Multi-Turn Conversation testing (M34 P6). Plays out each scenario's user turns
 * in order — the twin sees its own prior replies plus the next message — and
 * grades whether it stayed *consistent* across the whole conversation rather
 * than contradicting itself, caving to pushback, or forgetting a constraint.
 * Reuses the provider/model + persona selection from the parent TestTab via
 * props so all suites share one configuration. Lifecycle + shared presentation
 * live in `TwinEvaluationSuitePanel`; this file only declares the Multi-Turn
 * suite descriptor and its expanded-detail renderer (a full transcript).
 */
const SUITE = {
  HeaderIcon: MessagesSquare,
  title: 'Multi-Turn Conversation Tests',
  description: 'Multi-message exchanges scored on whether your twin stays consistent across the whole conversation.',
  runLabel: 'Run Conversations',
  loadingText: 'Loading conversation suite',
  itemLabel: 'Conversation',
  emptyState: (
    <>
      No multi-turn suite found. Add a <span className="text-gray-300">MULTI_TURN_SUITE.md</span> to your digital twin folder to enable these tests.
    </>
  ),
  scoreLabel: 'Consistency Score',
  countField: 'consistent',
  historyTitle: 'Recent Conversation Runs',
  statusMap: MULTI_TURN_STATUS,
  passResult: 'consistent',
  failResult: 'inconsistent',
  getTests: api.getMultiTurnTests,
  getHistory: api.getMultiTurnTestHistory,
  runTests: api.runMultiTurnTests,
  successToast: 'Multi-turn conversation tests completed'
};

const renderTranscript = (tr) => (
  <div className="bg-port-card p-3 rounded space-y-2">
    {(tr.transcript || []).map((msg, i) => (
      <div key={i} className={msg.role === 'twin' ? 'pl-3 border-l-2 border-port-accent' : ''}>
        <span className={`text-xs uppercase tracking-wide ${msg.role === 'twin' ? 'text-port-accent' : 'text-gray-500'}`}>
          {msg.role === 'twin' ? 'Twin' : 'User'}
        </span>
        <p className="text-white whitespace-pre-wrap">{msg.content}</p>
      </div>
    ))}
    {tr.reasoning && (
      <p className="text-sm text-gray-400 mt-2 pt-2 border-t border-port-border">
        Reasoning: {tr.reasoning}
      </p>
    )}
  </div>
);

const renderDetail = (scenario, ctx) => (
  <div className="space-y-4">
    <div>
      <h4 className="text-sm font-medium text-gray-400 mb-1">User Turns</h4>
      <ol className="space-y-2 list-decimal list-inside">
        {scenario.turns?.map((turn, i) => (
          <li key={i} className="text-white bg-port-card p-3 rounded">{turn}</li>
        ))}
      </ol>
    </div>
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
      <div>
        <div className="text-port-success text-xs mb-1">Consistent Trajectory</div>
        <div className="text-gray-400 bg-port-card p-3 rounded">{scenario.consistentTrajectory}</div>
      </div>
      <div>
        <div className="text-port-error text-xs mb-1">Inconsistent Trajectory</div>
        <div className="text-gray-400 bg-port-card p-3 rounded">{scenario.inconsistentTrajectory}</div>
      </div>
    </div>

    <SuiteModelResponses item={scenario} label="Conversation" renderBody={renderTranscript} {...ctx} />
  </div>
);

export default function MultiTurnPanel(props) {
  return <TwinEvaluationSuitePanel suite={SUITE} renderDetail={renderDetail} {...props} />;
}
