import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Sparkles,
  Send,
  SkipForward,
  RefreshCw,
  ArrowRight,
  CheckCircle,
  MessageSquare
} from 'lucide-react';
import * as api from '../../services/api';
import toast from 'react-hot-toast';
import { ENRICHMENT_CATEGORIES } from './constants';
import ScaleInput from './ScaleInput';

const DIMENSION_LABELS = {
  openness: 'Openness',
  conscientiousness: 'Conscientiousness',
  extraversion: 'Extraversion',
  agreeableness: 'Agreeableness',
  neuroticism: 'Neuroticism',
  values: 'Values',
  communication: 'Communication',
  decision_making: 'Decision Making',
  boundaries: 'Boundaries',
  identity: 'Identity'
};

function getUrgencyBadge(confidence) {
  if (confidence < 0.3) return { text: 'Critical', cls: 'text-red-400 bg-red-500/20' };
  if (confidence < 0.5) return { text: 'Important', cls: 'text-orange-400 bg-orange-500/20' };
  return { text: 'Suggested', cls: 'text-yellow-400 bg-yellow-500/20' };
}

export default function NextActionBanner({ gaps, status, traits, onRefresh }) {
  const navigate = useNavigate();
  const [question, setQuestion] = useState(null);
  const [answer, setAnswer] = useState('');
  const [scaleValue, setScaleValue] = useState(null);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [skippedIndices, setSkippedIndices] = useState([]);

  const hasTraits = traits && Object.keys(traits).length > 0;
  const hasEnrichment = (status?.enrichmentProgress?.completedCategories || 0) > 0;
  const hasGaps = gaps && gaps.length > 0;

  const topGap = hasGaps ? gaps[0] : null;
  const topCategory = topGap?.suggestedCategory;
  const isListBased = topCategory && ENRICHMENT_CATEGORIES[topCategory]?.listBased;

  // Load a question for the top gap's category (only for Q&A categories)
  useEffect(() => {
    if (topCategory && !isListBased) {
      setSkippedIndices([]);
      loadQuestion(topCategory);
    }
  }, [topCategory, isListBased]);

  const loadQuestion = async (category, skipList = []) => {
    setLoading(true);
    const q = await api.getSoulEnrichQuestion(category, undefined, undefined, skipList.length ? skipList : undefined).catch(() => null);
    setQuestion(q);
    setAnswer('');
    setScaleValue(null);
    setLoading(false);
  };

  const handleSubmit = async () => {
    if (!question) return;
    const isScale = question.questionType === 'scale';

    if (isScale && scaleValue == null) return;
    if (!isScale && !answer.trim()) return;

    setSubmitting(true);

    const payload = {
      questionId: question.questionId,
      category: topCategory,
      question: question.question
    };

    if (isScale) {
      payload.questionType = 'scale';
      payload.scaleValue = scaleValue;
      payload.scaleQuestionId = question.scaleQuestionId;
    } else {
      payload.questionType = 'text';
      payload.answer = answer.trim();
    }

    await api.submitSoulEnrichAnswer(payload);
    toast.success(isScale ? 'Rating saved' : 'Answer saved');
    setAnswer('');
    setScaleValue(null);
    setSkippedIndices([]);
    onRefresh?.();
    await loadQuestion(topCategory);
    setSubmitting(false);
  };

  const handleSkip = () => {
    if (!topCategory || !question) return;
    const idx = question.questionType === 'scale' ? -(question.scaleIndex + 1) : question.questionIndex;
    const nextSkipped = idx != null ? [...skippedIndices, idx] : skippedIndices;
    setSkippedIndices(nextSkipped);
    loadQuestion(topCategory, nextSkipped);
  };

  const handleKeyDown = (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      const isScale = question?.questionType === 'scale';
      if (isScale ? scaleValue != null : answer.trim()) handleSubmit();
    }
  };

  // Mode 1: No traits and no enrichment - suggest interview
  if (!hasTraits && !hasEnrichment) {
    return (
      <div className="bg-gradient-to-r from-purple-500/10 to-pink-500/10 border border-purple-500/30 rounded-lg p-5">
        <div className="flex items-start gap-3">
          <MessageSquare className="w-5 h-5 text-purple-400 mt-0.5 flex-shrink-0" />
          <div className="flex-1">
            <h3 className="text-white font-medium mb-1">Get started with a personality assessment</h3>
            <p className="text-sm text-gray-400 mb-3">
              Paste results from a personality test (Big Five, MBTI, Enneagram) to quickly seed your digital twin profile.
            </p>
            <button
              onClick={() => navigate('/digital-twin/interview')}
              className="px-4 py-2 bg-purple-600 text-white rounded-lg text-sm hover:bg-purple-500 flex items-center gap-2"
            >
              Go to Interview
              <ArrowRight size={14} />
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Mode 3: No gaps - all caught up
  if (!hasGaps) {
    return (
      <div className="bg-green-500/10 border border-green-500/30 rounded-lg p-5">
        <div className="flex items-start gap-3">
          <CheckCircle className="w-5 h-5 text-green-400 mt-0.5 flex-shrink-0" />
          <div className="flex-1">
            <h3 className="text-white font-medium mb-1">Your twin is well-defined</h3>
            <p className="text-sm text-gray-400 mb-3">
              All personality dimensions have strong confidence. Run behavioral tests to validate accuracy.
            </p>
            <button
              onClick={() => navigate('/digital-twin/test')}
              className="px-4 py-2 bg-green-600 text-white rounded-lg text-sm hover:bg-green-500 flex items-center gap-2"
            >
              Run Tests
              <ArrowRight size={14} />
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Mode 2: Gaps exist - inline question or navigate prompt
  const urgency = getUrgencyBadge(topGap.confidence);
  const dimensionLabel = DIMENSION_LABELS[topGap.dimension] || topGap.dimension;

  // List-based category: show navigate prompt instead of inline Q&A
  if (isListBased) {
    const catConfig = ENRICHMENT_CATEGORIES[topCategory];
    return (
      <div className="bg-gradient-to-r from-yellow-500/10 to-orange-500/10 border border-yellow-500/30 rounded-lg p-5">
        <div className="flex items-start gap-3">
          <Sparkles className="w-5 h-5 text-yellow-400 mt-0.5 flex-shrink-0" />
          <div className="flex-1">
            <div className="flex items-center gap-2 mb-1">
              <h3 className="text-white font-medium">Enrich: {dimensionLabel}</h3>
              <span className={`text-xs px-2 py-0.5 rounded-full ${urgency.cls}`}>{urgency.text}</span>
            </div>
            <p className="text-sm text-gray-400 mb-3">
              Add your {catConfig?.label?.toLowerCase() || 'items'} to strengthen this dimension.
            </p>
            <button
              onClick={() => navigate(`/digital-twin/enrich?category=${topCategory}`)}
              className="px-4 py-2 bg-yellow-600 text-white rounded-lg text-sm hover:bg-yellow-500 flex items-center gap-2"
            >
              Add {catConfig?.label || 'Items'}
              <ArrowRight size={14} />
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Q&A-based category: inline question
  return (
    <div className="bg-gradient-to-r from-yellow-500/10 to-orange-500/10 border border-yellow-500/30 rounded-lg p-5">
      <div className="flex items-start gap-3">
        <Sparkles className="w-5 h-5 text-yellow-400 mt-0.5 flex-shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <h3 className="text-white font-medium">Quick Enrich: {dimensionLabel}</h3>
            <span className={`text-xs px-2 py-0.5 rounded-full ${urgency.cls}`}>{urgency.text}</span>
          </div>

          {loading ? (
            <div className="flex items-center gap-2 text-gray-400 py-4">
              <RefreshCw className="w-4 h-4 animate-spin" />
              Loading question...
            </div>
          ) : question ? (
            <>
              <p className="text-sm text-gray-300 mb-3">{question.question}</p>
              {question.questionType === 'scale' ? (
                <div className="mb-2">
                  <ScaleInput
                    labels={question.labels}
                    value={scaleValue}
                    onChange={setScaleValue}
                    disabled={submitting}
                  />
                </div>
              ) : (
                <textarea
                  value={answer}
                  onChange={(e) => setAnswer(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder="Type your answer..."
                  rows={3}
                  className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white text-sm resize-none focus:outline-none focus:border-port-accent mb-2"
                />
              )}
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <button
                    onClick={handleSubmit}
                    disabled={submitting || (question.questionType === 'scale' ? scaleValue == null : !answer.trim())}
                    className="px-3 py-1.5 bg-port-accent text-white rounded-lg text-sm hover:bg-port-accent/80 disabled:opacity-50 flex items-center gap-1.5"
                  >
                    {submitting ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Send size={14} />}
                    Submit
                  </button>
                  <button
                    onClick={handleSkip}
                    className="px-3 py-1.5 text-gray-400 hover:text-white text-sm flex items-center gap-1.5"
                  >
                    <SkipForward size={14} />
                    Skip
                  </button>
                </div>
                <button
                  onClick={() => navigate(`/digital-twin/enrich?category=${topCategory}`)}
                  className="text-xs text-port-accent hover:text-white"
                >
                  Full enrichment →
                </button>
              </div>
              {question.questionType !== 'scale' && (
                <div className="text-xs text-gray-600 mt-1">Ctrl+Enter to submit</div>
              )}
            </>
          ) : (
            <p className="text-sm text-gray-400">Unable to load question.</p>
          )}
        </div>
      </div>
    </div>
  );
}
