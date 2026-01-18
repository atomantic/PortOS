import { useState } from 'react';
import {
  ChevronRight,
  ChevronLeft,
  User,
  Heart,
  MessageSquare,
  GitBranch,
  Shield,
  Check,
  RefreshCw,
  Sparkles
} from 'lucide-react';
import * as api from '../../services/api';
import toast from 'react-hot-toast';

const WIZARD_STEPS = [
  {
    id: 'identity',
    title: 'Identity Basics',
    description: 'Who are you?',
    icon: User,
    fields: [
      { id: 'name', label: 'Name', placeholder: 'Your name', type: 'text' },
      { id: 'role', label: 'Primary Role', placeholder: 'e.g., Software Engineer, Designer, Writer', type: 'text' },
      { id: 'oneLiner', label: 'One-liner', placeholder: 'Describe yourself in one sentence', type: 'text' }
    ]
  },
  {
    id: 'values',
    title: 'Core Values',
    description: 'What matters most to you?',
    icon: Heart,
    fields: [
      { id: 'value1', label: 'Value 1', placeholder: 'e.g., Intellectual honesty', type: 'text' },
      { id: 'value2', label: 'Value 2', placeholder: 'e.g., Continuous learning', type: 'text' },
      { id: 'value3', label: 'Value 3', placeholder: 'e.g., Craftsmanship', type: 'text' }
    ]
  },
  {
    id: 'communication',
    title: 'Communication Style',
    description: 'How do you communicate?',
    icon: MessageSquare,
    fields: [
      { id: 'tone', label: 'Preferred Tone', placeholder: 'e.g., Direct but warm, formal, casual', type: 'text' },
      { id: 'feedback', label: 'Feedback Preference', placeholder: 'How do you like to receive feedback?', type: 'text' },
      { id: 'verbosity', label: 'Verbosity', placeholder: 'e.g., Concise, detailed, depends on context', type: 'text' }
    ]
  },
  {
    id: 'decisions',
    title: 'Decision Making',
    description: 'How do you make choices?',
    icon: GitBranch,
    fields: [
      { id: 'speed', label: 'Decision Speed', placeholder: 'Quick decider or deliberate thinker?', type: 'text' },
      { id: 'approach', label: 'Approach', placeholder: 'e.g., Data-driven, intuition-guided, balanced', type: 'text' },
      { id: 'risk', label: 'Risk Tolerance', placeholder: 'How comfortable are you with uncertainty?', type: 'text' }
    ]
  },
  {
    id: 'boundaries',
    title: 'Non-Negotiables',
    description: 'What should your twin never do?',
    icon: Shield,
    fields: [
      { id: 'boundary1', label: 'Boundary 1', placeholder: 'What behavior is unacceptable?', type: 'text' },
      { id: 'boundary2', label: 'Boundary 2', placeholder: 'What topic should be avoided?', type: 'text' },
      { id: 'irritant', label: 'Pet Peeve', placeholder: 'What communication style irritates you?', type: 'text' }
    ]
  }
];

export default function SoulWizard({ onComplete, onCancel }) {
  const [currentStep, setCurrentStep] = useState(0);
  const [formData, setFormData] = useState({});
  const [saving, setSaving] = useState(false);

  const step = WIZARD_STEPS[currentStep];
  const StepIcon = step.icon;
  const isLastStep = currentStep === WIZARD_STEPS.length - 1;
  const progress = ((currentStep + 1) / WIZARD_STEPS.length) * 100;

  const updateField = (fieldId, value) => {
    setFormData({
      ...formData,
      [step.id]: {
        ...(formData[step.id] || {}),
        [fieldId]: value
      }
    });
  };

  const canProceed = () => {
    const stepData = formData[step.id] || {};
    return step.fields.some(f => stepData[f.id]?.trim());
  };

  const generateSoulDocument = () => {
    const { identity = {}, values = {}, communication = {}, decisions = {}, boundaries = {} } = formData;

    return `# Soul Document

## Identity

**Name**: ${identity.name || 'Not specified'}
**Role**: ${identity.role || 'Not specified'}
**One-liner**: ${identity.oneLiner || 'Not specified'}

## Core Values

${values.value1 ? `1. **${values.value1}**` : ''}
${values.value2 ? `2. **${values.value2}**` : ''}
${values.value3 ? `3. **${values.value3}**` : ''}

## Communication Style

- **Preferred Tone**: ${communication.tone || 'Not specified'}
- **Feedback Preference**: ${communication.feedback || 'Not specified'}
- **Verbosity**: ${communication.verbosity || 'Not specified'}

## Decision Making

- **Decision Speed**: ${decisions.speed || 'Not specified'}
- **Approach**: ${decisions.approach || 'Not specified'}
- **Risk Tolerance**: ${decisions.risk || 'Not specified'}

## Non-Negotiables

${boundaries.boundary1 ? `- **Boundary**: ${boundaries.boundary1}` : ''}
${boundaries.boundary2 ? `- **Avoid**: ${boundaries.boundary2}` : ''}
${boundaries.irritant ? `- **Pet Peeve**: ${boundaries.irritant}` : ''}

---
*Generated via Soul Creation Wizard*
`.trim();
  };

  const handleComplete = async () => {
    setSaving(true);
    const content = generateSoulDocument();

    await api.createSoulDocument({
      filename: 'SOUL.md',
      title: 'Soul',
      category: 'core',
      content
    });

    toast.success('Soul document created!');
    setSaving(false);
    onComplete();
  };

  return (
    <div className="bg-port-card rounded-lg border border-port-accent/30 p-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <Sparkles className="w-6 h-6 text-port-accent" />
          <h2 className="text-xl font-bold text-white">Create Your Soul</h2>
        </div>
        <button
          onClick={onCancel}
          className="text-gray-400 hover:text-white"
        >
          Skip for now
        </button>
      </div>

      {/* Progress Bar */}
      <div className="mb-6">
        <div className="flex items-center justify-between text-sm text-gray-400 mb-2">
          <span>Step {currentStep + 1} of {WIZARD_STEPS.length}</span>
          <span>{Math.round(progress)}% complete</span>
        </div>
        <div className="h-2 bg-port-border rounded-full overflow-hidden">
          <div
            className="h-full bg-port-accent transition-all"
            style={{ width: `${progress}%` }}
          />
        </div>
      </div>

      {/* Step Header */}
      <div className="flex items-center gap-4 mb-6">
        <div className="p-3 rounded-lg bg-port-accent/20">
          <StepIcon className="w-6 h-6 text-port-accent" />
        </div>
        <div>
          <h3 className="text-lg font-semibold text-white">{step.title}</h3>
          <p className="text-gray-400">{step.description}</p>
        </div>
      </div>

      {/* Fields */}
      <div className="space-y-4 mb-6">
        {step.fields.map(field => (
          <div key={field.id}>
            <label className="block text-sm text-gray-400 mb-1">{field.label}</label>
            <input
              type={field.type}
              value={formData[step.id]?.[field.id] || ''}
              onChange={(e) => updateField(field.id, e.target.value)}
              placeholder={field.placeholder}
              className="w-full px-4 py-2 bg-port-bg border border-port-border rounded-lg text-white placeholder-gray-500 focus:outline-none focus:border-port-accent"
            />
          </div>
        ))}
      </div>

      {/* Navigation */}
      <div className="flex items-center justify-between">
        <button
          onClick={() => setCurrentStep(Math.max(0, currentStep - 1))}
          disabled={currentStep === 0}
          className="flex items-center gap-2 px-4 py-2 text-gray-400 hover:text-white disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <ChevronLeft size={18} />
          Back
        </button>

        {isLastStep ? (
          <button
            onClick={handleComplete}
            disabled={saving || !canProceed()}
            className="flex items-center gap-2 px-6 py-2 bg-green-600 text-white rounded-lg hover:bg-green-500 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {saving ? (
              <>
                <RefreshCw className="w-4 h-4 animate-spin" />
                Creating...
              </>
            ) : (
              <>
                <Check size={18} />
                Create Soul
              </>
            )}
          </button>
        ) : (
          <button
            onClick={() => setCurrentStep(Math.min(WIZARD_STEPS.length - 1, currentStep + 1))}
            disabled={!canProceed()}
            className="flex items-center gap-2 px-6 py-2 bg-port-accent text-white rounded-lg hover:bg-port-accent/80 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Next
            <ChevronRight size={18} />
          </button>
        )}
      </div>

      {/* Step Indicators */}
      <div className="flex items-center justify-center gap-2 mt-6">
        {WIZARD_STEPS.map((s, index) => (
          <button
            key={s.id}
            onClick={() => setCurrentStep(index)}
            className={`w-2 h-2 rounded-full transition-colors ${
              index === currentStep
                ? 'bg-port-accent'
                : index < currentStep
                ? 'bg-green-500'
                : 'bg-port-border'
            }`}
          />
        ))}
      </div>
    </div>
  );
}
