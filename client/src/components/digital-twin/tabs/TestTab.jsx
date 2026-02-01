import { useState, useEffect } from 'react';
import {
  Play,
  CheckCircle,
  XCircle,
  AlertCircle,
  Clock,
  ChevronDown,
  ChevronRight,
  RefreshCw,
  History,
  Wand2,
  Plus
} from 'lucide-react';
import * as api from '../../../services/api';
import toast from 'react-hot-toast';

import { TEST_STATUS, formatRelativeTime } from '../constants';

export default function TestTab({ onRefresh }) {
  const [tests, setTests] = useState([]);
  const [providers, setProviders] = useState([]);
  const [history, setHistory] = useState([]);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);

  // Test configuration
  const [selectedProviders, setSelectedProviders] = useState([]);
  const [selectedTests, setSelectedTests] = useState([]);

  // Results
  const [results, setResults] = useState([]);
  const [expandedTest, setExpandedTest] = useState(null);

  // Generated tests
  const [generatedTests, setGeneratedTests] = useState([]);
  const [generating, setGenerating] = useState(false);
  const [showGenerated, setShowGenerated] = useState(false);

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    setLoading(true);
    const [testsData, providersData, historyData] = await Promise.all([
      api.getSoulTests().catch(() => []),
      api.getProviders().catch(() => ({ providers: [] })),
      api.getSoulTestHistory(5).catch(() => [])
    ]);

    setTests(testsData);
    const providersList = providersData.providers || [];
    setProviders(providersList.filter(p => p.enabled));
    setHistory(historyData);

    // Default: select all tests
    setSelectedTests(testsData.map(t => t.testId));

    setLoading(false);
  };

  const toggleProvider = (providerId, model) => {
    const key = `${providerId}:${model}`;
    setSelectedProviders(prev => {
      const exists = prev.some(p => `${p.providerId}:${p.model}` === key);
      if (exists) {
        return prev.filter(p => `${p.providerId}:${p.model}` !== key);
      }
      return [...prev, { providerId, model }];
    });
  };

  const toggleTest = (testId) => {
    setSelectedTests(prev =>
      prev.includes(testId) ? prev.filter(id => id !== testId) : [...prev, testId]
    );
  };

  const runTests = async () => {
    if (selectedProviders.length === 0) {
      toast.error('Select at least one provider/model');
      return;
    }

    setRunning(true);
    setResults([]);

    const testIds = selectedTests.length > 0 ? selectedTests : null;

    if (selectedProviders.length === 1) {
      // Single provider test
      const { providerId, model } = selectedProviders[0];
      const result = await api.runSoulTests(providerId, model, testIds);
      setResults([{ providerId, model, ...result }]);
    } else {
      // Multi-provider test
      const multiResults = await api.runSoulMultiTests(selectedProviders, testIds);
      setResults(multiResults);
    }

    await loadData();
    setRunning(false);
    toast.success('Tests completed');
    onRefresh();
  };

  const getResultIcon = (result) => {
    switch (result) {
      case 'passed':
        return <CheckCircle className="w-5 h-5 text-green-400" />;
      case 'failed':
        return <XCircle className="w-5 h-5 text-red-400" />;
      case 'partial':
        return <AlertCircle className="w-5 h-5 text-yellow-400" />;
      default:
        return <Clock className="w-5 h-5 text-gray-400" />;
    }
  };

  const generateTests = async () => {
    if (selectedProviders.length === 0) {
      toast.error('Select at least one provider/model first');
      return;
    }

    setGenerating(true);
    const { providerId, model } = selectedProviders[0];
    const result = await api.generateSoulTests(providerId, model).catch(e => ({ error: e.message }));

    if (result.error) {
      toast.error(result.error);
    } else if (result.tests?.length > 0) {
      setGeneratedTests(result.tests);
      setShowGenerated(true);
      toast.success(`Generated ${result.tests.length} tests`);
    } else {
      toast.error('No tests generated');
    }
    setGenerating(false);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <RefreshCw className="w-8 h-8 text-port-accent animate-spin" />
      </div>
    );
  }

  if (tests.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-64 text-center">
        <AlertCircle className="w-12 h-12 text-yellow-400 mb-4" />
        <h2 className="text-lg font-semibold text-white mb-2">No Test Suite Found</h2>
        <p className="text-gray-400 max-w-md">
          Create a BEHAVIORAL_TEST_SUITE.md document in your soul folder to enable behavioral testing.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Configuration */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 sm:gap-6">
        {/* Provider Selection */}
        <div className="bg-port-card rounded-lg border border-port-border p-4">
          <h3 className="font-semibold text-white mb-4">Select Providers & Models</h3>
          <div className="space-y-3 max-h-64 overflow-y-auto">
            {providers.map(provider => (
              <div key={provider.id} className="space-y-2">
                <div className="text-sm font-medium text-gray-400">{provider.name}</div>
                <div className="flex flex-wrap gap-2">
                  {(provider.models || [provider.defaultModel]).filter(Boolean).map(model => {
                    const isSelected = selectedProviders.some(
                      p => p.providerId === provider.id && p.model === model
                    );
                    return (
                      <button
                        key={model}
                        onClick={() => toggleProvider(provider.id, model)}
                        className={`px-3 py-2 min-h-[40px] text-sm rounded-lg border transition-colors ${
                          isSelected
                            ? 'bg-port-accent/20 border-port-accent text-port-accent'
                            : 'border-port-border text-gray-400 hover:text-white hover:border-gray-500'
                        }`}
                      >
                        {model}
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Test Selection */}
        <div className="bg-port-card rounded-lg border border-port-border p-4">
          <div className="flex items-center justify-between mb-4">
            <h3 className="font-semibold text-white">Select Tests ({selectedTests.length}/{tests.length})</h3>
            <div className="flex gap-3">
              <button
                onClick={() => setSelectedTests(tests.map(t => t.testId))}
                className="text-xs py-1 px-2 min-h-[32px] text-port-accent hover:text-white"
              >
                All
              </button>
              <button
                onClick={() => setSelectedTests([])}
                className="text-xs py-1 px-2 min-h-[32px] text-gray-500 hover:text-white"
              >
                None
              </button>
            </div>
          </div>
          <div className="space-y-1 max-h-64 overflow-y-auto">
            {tests.map(test => (
              <label
                key={test.testId}
                className="flex items-center gap-3 p-2 min-h-[44px] rounded hover:bg-port-border cursor-pointer"
              >
                <input
                  type="checkbox"
                  checked={selectedTests.includes(test.testId)}
                  onChange={() => toggleTest(test.testId)}
                  className="w-5 h-5 rounded border-port-border bg-port-bg text-port-accent focus:ring-port-accent"
                />
                <span className="text-sm text-white">
                  {test.testId}. {test.testName}
                </span>
              </label>
            ))}
          </div>
        </div>
      </div>

      {/* Run Button */}
      <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3 sm:gap-4">
        <button
          onClick={runTests}
          disabled={running || selectedProviders.length === 0}
          className="flex items-center justify-center gap-2 px-6 py-3 min-h-[48px] bg-port-accent text-white rounded-lg font-medium hover:bg-port-accent/80 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {running ? (
            <>
              <RefreshCw className="w-5 h-5 animate-spin" />
              Running Tests...
            </>
          ) : (
            <>
              <Play className="w-5 h-5" />
              Run Selected Tests
            </>
          )}
        </button>

        <button
          onClick={generateTests}
          disabled={generating || selectedProviders.length === 0}
          className="flex items-center justify-center gap-2 px-4 py-3 min-h-[48px] bg-purple-600 text-white rounded-lg font-medium hover:bg-purple-500 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {generating ? (
            <>
              <RefreshCw className="w-5 h-5 animate-spin" />
              Generating...
            </>
          ) : (
            <>
              <Wand2 className="w-5 h-5" />
              Generate Tests
            </>
          )}
        </button>

        {selectedProviders.length > 0 && (
          <span className="text-sm text-gray-500 text-center sm:text-left">
            Testing against {selectedProviders.length} model{selectedProviders.length > 1 ? 's' : ''}
          </span>
        )}
      </div>

      {/* Generated Tests */}
      {showGenerated && generatedTests.length > 0 && (
        <div className="bg-port-card rounded-lg border border-purple-500/30 overflow-hidden">
          <div className="p-4 border-b border-port-border flex items-center justify-between">
            <h3 className="font-semibold text-white flex items-center gap-2">
              <Wand2 className="w-5 h-5 text-purple-400" />
              AI-Generated Tests ({generatedTests.length})
            </h3>
            <button
              onClick={() => setShowGenerated(false)}
              className="text-sm text-gray-400 hover:text-white"
            >
              Hide
            </button>
          </div>
          <div className="p-4 space-y-4">
            {generatedTests.map((test, index) => (
              <div
                key={index}
                className="p-4 bg-port-bg rounded-lg border border-port-border"
              >
                <div className="flex items-start justify-between mb-2">
                  <div className="font-medium text-white">{test.testName}</div>
                  <span className={`text-xs px-2 py-1 rounded ${
                    test.category === 'values' ? 'bg-purple-500/20 text-purple-400' :
                    test.category === 'communication' ? 'bg-blue-500/20 text-blue-400' :
                    test.category === 'non_negotiables' ? 'bg-red-500/20 text-red-400' :
                    test.category === 'decision_making' ? 'bg-orange-500/20 text-orange-400' :
                    'bg-rose-500/20 text-rose-400'
                  }`}>
                    {test.category?.replace('_', ' ')}
                  </span>
                </div>
                <div className="text-sm text-gray-300 mb-3">
                  <span className="text-gray-500">Prompt:</span> "{test.prompt}"
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 sm:gap-4 text-sm">
                  <div>
                    <div className="text-green-400 text-xs mb-1">Expected Behavior</div>
                    <div className="text-gray-400">{test.expectedBehavior}</div>
                  </div>
                  <div>
                    <div className="text-red-400 text-xs mb-1">Failure Signals</div>
                    <div className="text-gray-400">{test.failureSignals}</div>
                  </div>
                </div>
                {test.rationale && (
                  <div className="mt-3 pt-3 border-t border-port-border text-sm text-gray-500">
                    {test.rationale}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Results */}
      {results.length > 0 && (
        <div className="bg-port-card rounded-lg border border-port-border overflow-hidden">
          <div className="p-4 border-b border-port-border">
            <h3 className="font-semibold text-white">Results</h3>
          </div>

          {/* Results Table */}
          <div className="overflow-x-auto -mx-4 sm:mx-0">
            <table className="w-full min-w-[500px]">
              <thead>
                <tr className="border-b border-port-border">
                  <th className="px-4 py-3 text-left text-sm font-medium text-gray-400">Test</th>
                  {results.map(r => (
                    <th key={`${r.providerId}-${r.model}`} className="px-4 py-3 text-left text-sm font-medium text-gray-400">
                      {r.model}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {tests.filter(t => selectedTests.includes(t.testId)).map(test => (
                  <tr
                    key={test.testId}
                    className="border-b border-port-border last:border-b-0 hover:bg-port-border/30"
                  >
                    <td className="px-4 py-3">
                      <button
                        onClick={() => setExpandedTest(expandedTest === test.testId ? null : test.testId)}
                        className="flex items-center gap-2 text-sm text-white"
                      >
                        {expandedTest === test.testId ? (
                          <ChevronDown size={14} />
                        ) : (
                          <ChevronRight size={14} />
                        )}
                        {test.testId}. {test.testName}
                      </button>
                    </td>
                    {results.map(r => {
                      const testResult = r.results?.find(tr => tr.testId === test.testId);
                      return (
                        <td key={`${r.providerId}-${r.model}`} className="px-4 py-3">
                          {testResult ? (
                            <div className="flex items-center gap-2">
                              {getResultIcon(testResult.result)}
                              <span className={`text-sm ${TEST_STATUS[testResult.result]?.color?.split(' ')[1]}`}>
                                {TEST_STATUS[testResult.result]?.label}
                              </span>
                            </div>
                          ) : (
                            <span className="text-gray-500">—</span>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                ))}

                {/* Summary Row */}
                <tr className="bg-port-border/30">
                  <td className="px-4 py-3 font-medium text-white">Total Score</td>
                  {results.map(r => (
                    <td key={`${r.providerId}-${r.model}-score`} className="px-4 py-3">
                      <span className={`text-lg font-bold ${
                        r.score >= 0.8 ? 'text-green-400' :
                        r.score >= 0.5 ? 'text-yellow-400' : 'text-red-400'
                      }`}>
                        {Math.round((r.score || 0) * 100)}%
                      </span>
                      <span className="text-sm text-gray-500 ml-2">
                        ({r.passed || 0}/{r.total || 0})
                      </span>
                    </td>
                  ))}
                </tr>
              </tbody>
            </table>
          </div>

          {/* Expanded Test Details */}
          {expandedTest && (
            <div className="p-4 bg-port-bg border-t border-port-border">
              {(() => {
                const test = tests.find(t => t.testId === expandedTest);
                if (!test) return null;

                return (
                  <div className="space-y-4">
                    <div>
                      <h4 className="text-sm font-medium text-gray-400 mb-1">Prompt</h4>
                      <p className="text-white bg-port-card p-3 rounded">{test.prompt}</p>
                    </div>
                    <div>
                      <h4 className="text-sm font-medium text-gray-400 mb-1">Expected Behavior</h4>
                      <p className="text-green-400 bg-port-card p-3 rounded whitespace-pre-wrap">{test.expectedBehavior}</p>
                    </div>
                    <div>
                      <h4 className="text-sm font-medium text-gray-400 mb-1">Failure Signals</h4>
                      <p className="text-red-400 bg-port-card p-3 rounded whitespace-pre-wrap">{test.failureSignals}</p>
                    </div>

                    {/* Model Responses */}
                    {results.map(r => {
                      const testResult = r.results?.find(tr => tr.testId === expandedTest);
                      if (!testResult) return null;

                      return (
                        <div key={`${r.providerId}-${r.model}-response`}>
                          <h4 className="text-sm font-medium text-gray-400 mb-1">
                            {r.model} Response {getResultIcon(testResult.result)}
                          </h4>
                          <div className="bg-port-card p-3 rounded">
                            <p className="text-white whitespace-pre-wrap">{testResult.response}</p>
                            {testResult.reasoning && (
                              <p className="text-sm text-gray-400 mt-2 pt-2 border-t border-port-border">
                                Reasoning: {testResult.reasoning}
                              </p>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                );
              })()}
            </div>
          )}
        </div>
      )}

      {/* History */}
      {history.length > 0 && (
        <div className="bg-port-card rounded-lg border border-port-border p-4">
          <h3 className="font-semibold text-white mb-4 flex items-center gap-2">
            <History size={18} />
            Recent Test Runs
          </h3>
          <div className="space-y-3">
            {history.map(run => (
              <div
                key={run.runId}
                className="flex items-center justify-between p-3 rounded bg-port-bg"
              >
                <div className="flex items-center gap-4">
                  <span className={`text-xl font-bold ${
                    run.score >= 0.8 ? 'text-green-400' :
                    run.score >= 0.5 ? 'text-yellow-400' : 'text-red-400'
                  }`}>
                    {Math.round(run.score * 100)}%
                  </span>
                  <div>
                    <div className="text-sm text-white">{run.model}</div>
                    <div className="text-xs text-gray-500">
                      {run.passed}/{run.total} passed • {formatRelativeTime(run.timestamp)}
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
