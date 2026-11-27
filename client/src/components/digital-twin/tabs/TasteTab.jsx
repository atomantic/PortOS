import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import BrailleSpinner from '../../BrailleSpinner';
import {
  getTasteProfile,
  getTasteNextQuestion,
  skipTasteFollowUp,
  submitTasteAnswer,
  getPersonalizedTasteQuestion,
  getTasteSectionResponses,
  resetTasteSection,
  generateTasteSummary,
  submitBehavioralFeedback,
} from '../../../services/apiDigitalTwin.js';
import socket from '../../../services/socket';
import toast from '../../ui/Toast';
import useProviderList from '../../../hooks/useProviderList';
import { isApiProvider } from '../../../utils/providers';
import TasteOverview from './TasteOverview';
import TasteQuestionSession from './TasteQuestionSession';
import TasteReviewView from './TasteReviewView';

const NO_API_PROVIDER_TOAST = 'No API provider configured — open AI Providers to add one (e.g. LM Studio, OpenAI).';

// "Go deeper" came back with no question. Each `reason` names the precondition that
// was actually missing, so only a genuine lack of identity context points the user at
// their documents (#2733) — the other reasons aren't about documents at all.
const NO_QUESTION_TOAST = {
  'no-context': 'No personalized question available — try completing more identity documents',
  'no-provider': NO_API_PROVIDER_TOAST,
  'unknown-section': 'This section doesn\'t support personalized questions.'
};
const NO_QUESTION_FALLBACK_TOAST = 'No personalized question available right now.';

export const noQuestionToast = (reason) => NO_QUESTION_TOAST[reason] || NO_QUESTION_FALLBACK_TOAST;

/**
 * Whether "Go deeper" must report a failed request itself.
 *
 * A provider failure (502 `AI_PROVIDER_ERROR`) is already announced by the `ai:status`
 * error toast with the provider's real reason, so that toast is the single voice for it —
 * the server also marks it warning-severity so the global `error:notified` channel stays
 * quiet. Everything else — validation, 500, network drop — has no other reporter (the
 * request is sent `{ silent: true }`), so this component is its single voice.
 *
 * `statusChannelLive` is what keeps "someone else is reporting this" from collapsing into
 * "nobody is". `ai:status` is an unbuffered Socket.IO event: with the socket down, HTTP
 * still delivers the 502 but the toast never arrives, so deferring would fail the click
 * in total silence. Deferring only while the channel is live keeps exactly one layer
 * speaking in both states (#2733, #2669).
 */
export const shouldReportGoDeeperError = (err, statusChannelLive) =>
  err?.code !== 'AI_PROVIDER_ERROR' || !statusChannelLive;

export default function TasteTab({ onRefresh }) {
  const [profile, setProfile] = useState(null);
  const [profileError, setProfileError] = useState(null);
  const [loading, setLoading] = useState(true);
  // Failed read for the next question; rendered as a retryable error, not the completion banner.
  const [questionError, setQuestionError] = useState(null);

  // Active session state
  const [activeSection, setActiveSection] = useState(null);
  const [currentQuestion, setCurrentQuestion] = useState(null);
  const [answer, setAnswer] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [loadingQuestion, setLoadingQuestion] = useState(false);
  // Leaving a session invalidates every in-flight change to its displayed question.
  const questionRequestRef = useRef(0);

  // Summary generation
  const [generatingSummary, setGeneratingSummary] = useState(false);
  const providersResource = useProviderList();
  // Taste summaries / personalized questions need a chat-completions endpoint —
  // CLI providers (Claude Code, Codex, Antigravity CLI) can't run them. Filter the
  // picker so the user can't accidentally select an incompatible default.
  const providers = useMemo(
    () => providersResource.items.filter(p => p.enabled && isApiProvider(p)),
    [providersResource.items]
  );
  const [selectedProvider, setSelectedProvider] = useState(null);

  // Review mode
  const [reviewSection, setReviewSection] = useState(null);
  // Section id awaiting reset confirmation; cleared whenever the review view changes.
  const [confirmingReset, setConfirmingReset] = useState(null);
  const [resetting, setResetting] = useState(false);
  const [reviewResponses, setReviewResponses] = useState([]);
  const [loadingReview, setLoadingReview] = useState(false);
  const [reviewError, setReviewError] = useState(null);
  // Newest review request wins: a late answer for a section the user already left is dropped.
  const reviewRequestRef = useRef(0);

  // Personalized question state
  const [loadingPersonalized, setLoadingPersonalized] = useState(false);

  // Behavioral feedback
  const [summaryFeedback, setSummaryFeedback] = useState({}); // key: sectionId → validation

  // Expanded summaries
  const [expandedSummary, setExpandedSummary] = useState(null);

  const loadProfile = useCallback(async () => {
    setProfileError(null);
    try {
      setProfile(await getTasteProfile({ silent: true }));
    } catch (err) {
      // Keep a failed read distinct from an empty profile: the grid and progress
      // header must not render "0/7 sections complete" for a request that never answered.
      setProfileError(err);
    }
    setLoading(false);
  }, []);

  // Seed the default model once the provider list is read; a later re-read never
  // overrides a choice the user already made.
  useEffect(() => {
    if (providers.length > 0) {
      setSelectedProvider(prev => prev || { providerId: providers[0].id, model: providers[0].defaultModel });
    }
  }, [providers]);

  useEffect(() => {
    loadProfile();
  }, [loadProfile]);

  const startSection = async (sectionId) => {
    const request = ++questionRequestRef.current;
    setActiveSection(sectionId);
    setCurrentQuestion(null);
    setAnswer('');
    setLoadingQuestion(true);
    setQuestionError(null);
    try {
      const question = await getTasteNextQuestion(sectionId, { silent: true });
      if (questionRequestRef.current === request) setCurrentQuestion(question);
    } catch (err) {
      if (questionRequestRef.current === request) setQuestionError(err);
    } finally {
      if (questionRequestRef.current === request) setLoadingQuestion(false);
    }
  };

  const submitAnswer = async () => {
    if (!answer.trim() || !currentQuestion || submitting) return;

    const request = ++questionRequestRef.current;
    setSubmitting(true);
    const meta = currentQuestion.isPersonalized ? {
      source: 'personalized',
      generatedQuestion: currentQuestion.text,
      identityContextUsed: currentQuestion.identityContextUsed
    } : {};
    const result = await submitTasteAnswer(
      activeSection,
      currentQuestion.questionId,
      answer.trim(),
      meta,
      { silent: true }
    ).catch(() => null);

    if (!result) {
      toast.error('Failed to save response');
      if (questionRequestRef.current === request) setSubmitting(false);
      return;
    }

    toast.success('Response saved');
    if (questionRequestRef.current === request) {
      setAnswer('');
      setCurrentQuestion(currentQuestion.isPersonalized ? null : (result.nextQuestion ?? null));
    }
    await loadProfile();
    if (questionRequestRef.current === request) setSubmitting(false);
    onRefresh?.();
  };

  const skipQuestion = async () => {
    if (!currentQuestion?.isFollowUp || currentQuestion.isPersonalized || loadingQuestion || submitting) return;

    const request = ++questionRequestRef.current;
    setLoadingQuestion(true);
    try {
      const { nextQuestion } = await skipTasteFollowUp(activeSection, currentQuestion.questionId, { silent: true });
      if (questionRequestRef.current === request) {
        setCurrentQuestion(nextQuestion);
        setAnswer('');
      }
    } catch (err) {
      if (questionRequestRef.current === request) {
        toast.error(err?.message ? `Failed to skip question: ${err.message}` : 'Failed to skip question');
      }
      return;
    } finally {
      if (questionRequestRef.current === request) setLoadingQuestion(false);
    }
    await loadProfile();
    onRefresh?.();
  };

  const handleGoDeeper = async () => {
    if (!selectedProvider) {
      toast.error(NO_API_PROVIDER_TOAST);
      return;
    }

    const request = ++questionRequestRef.current;
    setLoadingPersonalized(true);
    try {
      const { question, reason } = await getPersonalizedTasteQuestion(
        activeSection,
        selectedProvider.providerId,
        selectedProvider.model,
        { silent: true }
      );
      if (questionRequestRef.current !== request) return;
      if (!question) {
        toast(noQuestionToast(reason), { icon: '⚠️' });
        return;
      }
      setCurrentQuestion(question);
      setAnswer('');
    } catch (err) {
      // ai:status may already report a provider failure. Check the socket when
      // the HTTP request fails so a disconnected socket never silences the error.
      if (questionRequestRef.current === request && shouldReportGoDeeperError(err, socket.connected)) {
        toast.error(err?.message || 'Failed to generate a personalized question');
      }
    } finally {
      if (questionRequestRef.current === request) setLoadingPersonalized(false);
    }
  };

  const exitSection = () => {
    questionRequestRef.current += 1;
    setActiveSection(null);
    setCurrentQuestion(null);
    setQuestionError(null);
    setAnswer('');
    setLoadingQuestion(false);
    setLoadingPersonalized(false);
    setSubmitting(false);
  };

  const exitReview = () => {
    reviewRequestRef.current += 1;
    setReviewSection(null);
    setReviewResponses([]);
    setLoadingReview(false);
    setReviewError(null);
    setConfirmingReset(null);
  };

  const handleReviewSection = async (sectionId) => {
    const request = ++reviewRequestRef.current;
    setConfirmingReset(null);
    setReviewSection(sectionId);
    setLoadingReview(true);
    setReviewError(null);
    setReviewResponses([]);
    const outcome = await getTasteSectionResponses(sectionId, { silent: true })
      .then(data => ({ responses: Array.isArray(data) ? data : [], error: null }))
      .catch(err => ({ responses: [], error: err instanceof Error ? err : new Error('Request failed') }));
    if (reviewRequestRef.current !== request) return;
    setReviewResponses(outcome.responses);
    setReviewError(outcome.error);
    setLoadingReview(false);
  };

  const handleResetSection = async (sectionId) => {
    // request() owns the failure toast; bail before the success toast so a
    // failed reset doesn't report "Section reset" on top of that error.
    if (resetting) return;
    const request = reviewRequestRef.current;
    setResetting(true);
    const ok = await resetTasteSection(sectionId).then(() => true).catch(() => false);
    setResetting(false);
    if (reviewRequestRef.current === request) setConfirmingReset(null);
    if (!ok) return;
    toast.success('Section reset');
    await loadProfile();
    if (reviewRequestRef.current === request) exitReview();
    onRefresh?.();
  };

  const handleGenerateSummary = async (sectionId) => {
    if (!selectedProvider) {
      toast.error(NO_API_PROVIDER_TOAST);
      return;
    }
    setGeneratingSummary(true);
    // apiCore.request already shows a toast on non-OK responses, so swallow
    // the rejection here instead of re-toasting the same error.
    const result = await generateTasteSummary(
      selectedProvider.providerId,
      selectedProvider.model,
      sectionId
    ).catch(() => null);

    if (result) {
      toast.success('Summary generated');
      await loadProfile();
    }
    setGeneratingSummary(false);
  };

  const submitSummaryFeedback = async (sectionId, summary, validation) => {
    setSummaryFeedback(prev => ({ ...prev, [sectionId]: validation }));
    await submitBehavioralFeedback({
      contentType: 'taste_summary',
      validation,
      contentSnippet: summary?.slice(0, 2000),
      context: `Taste section: ${sectionId}`,
      providerId: selectedProvider?.providerId,
      model: selectedProvider?.model,
      documentsUsed: ['TASTE_PROFILE.md']
    }, { silent: true }).catch(() => {
      toast.error('Failed to save feedback');
      setSummaryFeedback(prev => { const next = { ...prev }; delete next[sectionId]; return next; });
    });
  };

  const handleGenerateOverallSummary = async () => {
    if (!selectedProvider) {
      toast.error(NO_API_PROVIDER_TOAST);
      return;
    }
    setGeneratingSummary(true);
    const result = await generateTasteSummary(
      selectedProvider.providerId,
      selectedProvider.model
    ).catch(() => null);

    if (result) {
      toast.success('Taste profile generated');
      await loadProfile();
    }
    setGeneratingSummary(false);
    onRefresh?.();
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <BrailleSpinner text="Loading" />
      </div>
    );
  }

  if (reviewSection) {
    const section = profile?.sections?.find(s => s.id === reviewSection);
    return (
      <TasteReviewView
        section={section}
        reviewResponses={reviewResponses}
        loadingReview={loadingReview}
        reviewError={reviewError}
        onBack={exitReview}
        onRetry={() => handleReviewSection(reviewSection)}
        summaryFeedback={summaryFeedback[reviewSection]}
        onSummaryFeedback={(validation) => submitSummaryFeedback(reviewSection, section?.summary, validation)}
        providersResource={providersResource}
        selectedProvider={selectedProvider}
        generatingSummary={generatingSummary}
        onGenerateSummary={() => handleGenerateSummary(reviewSection)}
        resetting={resetting}
        confirmingReset={confirmingReset === reviewSection}
        onRequestReset={() => setConfirmingReset(reviewSection)}
        onConfirmReset={() => handleResetSection(reviewSection)}
        onCancelReset={() => setConfirmingReset(null)}
      />
    );
  }

  if (activeSection) {
    const section = profile?.sections?.find(s => s.id === activeSection);
    return (
      <TasteQuestionSession
        section={section}
        currentQuestion={currentQuestion}
        answer={answer}
        submitting={submitting}
        loadingQuestion={loadingQuestion}
        questionError={questionError}
        loadingPersonalized={loadingPersonalized}
        providersResource={providersResource}
        selectedProvider={selectedProvider}
        generatingSummary={generatingSummary}
        onBack={exitSection}
        onRetry={() => startSection(activeSection)}
        onReview={() => handleReviewSection(activeSection)}
        onGoDeeper={handleGoDeeper}
        onGenerateSummary={() => handleGenerateSummary(activeSection)}
        onAnswerChange={setAnswer}
        onDoneExploring={() => {
          setCurrentQuestion(null);
          setAnswer('');
        }}
        onSkip={skipQuestion}
        onSubmit={submitAnswer}
      />
    );
  }

  return (
    <TasteOverview
      profile={profile}
      profileError={profileError}
      providersResource={providersResource}
      providers={providers}
      selectedProvider={selectedProvider}
      generatingSummary={generatingSummary}
      expandedSummary={expandedSummary}
      onToggleSummary={(sectionId) => setExpandedSummary(prev => prev === sectionId ? null : sectionId)}
      onRetry={loadProfile}
      onStartSection={startSection}
      onReviewSection={handleReviewSection}
      onProviderChange={setSelectedProvider}
      onGenerateSummary={handleGenerateOverallSummary}
    />
  );
}
