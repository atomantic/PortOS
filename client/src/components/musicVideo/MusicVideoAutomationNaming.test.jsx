import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

vi.mock('../../services/socket', () => ({
  default: { on: vi.fn(), off: vi.fn() },
}));
vi.mock('../../services/apiMusicVideo.js', () => ({
  startMusicVideoProduction: vi.fn(),
  resumeMusicVideoProduction: vi.fn(),
  stopMusicVideoProduction: vi.fn(),
  cancelMusicVideoProduction: vi.fn(),
  startAutoReview: vi.fn(),
  resumeAutoReview: vi.fn(),
  stopAutoReview: vi.fn(),
  cancelAutoReview: vi.fn(),
}));
vi.mock('../ui/Toast', () => ({ default: { success: vi.fn(), info: vi.fn(), error: vi.fn() } }));
vi.mock('../../hooks/useProviderModels.js', () => ({
  default: () => ({
    providers: [], selectedProviderId: '', selectedModel: '', availableModels: [],
    setSelectedProviderId: () => {}, setSelectedModel: () => {},
  }),
}));

import AutopilotPanel from './AutopilotPanel.jsx';
import AutoReviewPanel from './AutoReviewPanel.jsx';
import ProductionReviewPanel from './ProductionReviewPanel.jsx';
import { deriveNextAction } from '../../lib/musicVideoStages.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const RETIRED_LABELS = [
  'Autopilot run',
  'Autonomous production',
  'Prepare planning draft with autopilot',
  'Resume autopilot',
  'Retry autopilot',
  'Set up autopilot',
];

describe('Music Video Automation Naming Canonical Conventions (#10166)', () => {
  it('greps music-video components for the retired labels to ensure none are used', () => {
    const componentFiles = fs.readdirSync(__dirname)
      .filter((file) => file.endsWith('.jsx') && !file.includes('.test.'));

    expect(componentFiles.length).toBeGreaterThan(0);

    const findings = [];
    for (const file of componentFiles) {
      const content = fs.readFileSync(path.join(__dirname, file), 'utf8');
      for (const retired of RETIRED_LABELS) {
        if (content.toLowerCase().includes(retired.toLowerCase())) {
          findings.push(`${file} contains retired label "${retired}"`);
        }
      }
    }

    expect(findings).toEqual([]);
  });

  it('renders Automation brief and Production run (opt-in) on the brief panel when independent', () => {
    const project = { id: 'p1', scenes: [], automation: null, productionRuns: [] };
    render(
      <AutopilotPanel
        project={project}
        production={{ busy: false }}
        readiness={{}}
        onSave={vi.fn()}
        onKickoff={vi.fn()}
      />
    );

    expect(screen.getByRole('heading', { level: 3, name: 'Automation brief' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Set up automation brief' })).toBeInTheDocument();
    expect(screen.getByText(/Production run \(opt-in\)/)).toBeInTheDocument();
  });

  it('labels production run as "Started by the autonomous run" with link back when started by autonomous run', () => {
    const project = {
      id: 'p1',
      scenes: [],
      autonomousRun: { id: 'auto-1', output: { productionRunId: 'pr-1' } },
      productionRuns: [{
        id: 'pr-1',
        status: 'running',
        directive: '',
        pool: [],
        limits: { maxGenerations: 10, maxReviewAttempts: 2 },
        usage: { generations: 0, reviews: 0, costUsd: 0 },
        steps: [],
      }],
    };
    render(
      <MemoryRouter initialEntries={['/music-video/p1/board']}>
        <AutopilotPanel
          project={project}
          production={{ busy: false }}
          readiness={{}}
          onSave={vi.fn()}
          onKickoff={vi.fn()}
        />
      </MemoryRouter>
    );

    expect(screen.queryByText(/Production run \(opt-in\)/)).toBeNull();
    expect(screen.getByText('Production run')).toBeInTheDocument();
    const link = screen.getByRole('link', { name: 'Started by the autonomous run' });
    expect(link).toBeInTheDocument();
    // It stays on the open step and opens Project settings › Autopilot at the run log.
    expect(link).toHaveAttribute('href', '/music-video/p1/board?mvPanel=autopilot#mv-autonomous-run');
  });

  it('renders Auto-review (opt-in) on Review when not started by autonomous run', () => {
    const project = { id: 'p1', autoReviews: [] };
    render(
      <AutoReviewPanel
        project={project}
        startSec={0}
        endSec={5}
        rangeValid={true}
        rendering={false}
        autoReview={{ busy: false }}
      />
    );

    expect(screen.getByText(/Auto-review \(opt-in\)/)).toBeInTheDocument();
  });

  it('labels auto-review as "Started by the autonomous run" with link back when started by autonomous run', () => {
    const project = {
      id: 'p1',
      autonomousRun: { id: 'auto-1', output: { productionRunId: 'pr-1' } },
      autoReviews: [{
        id: 'ar-1',
        status: 'running',
        productionRunId: 'pr-1',
        startSec: 0,
        endSec: 5,
        limits: { maxAttempts: 3, maxGenerations: 4 },
        usage: { reviews: 0, generations: 0 },
        attempts: [],
      }],
    };
    render(
      <MemoryRouter initialEntries={['/music-video/p1/board']}>
        <AutoReviewPanel
          project={project}
          startSec={0}
          endSec={5}
          rangeValid={true}
          rendering={false}
          autoReview={{ busy: false }}
        />
      </MemoryRouter>
    );

    expect(screen.queryByText(/Auto-review \(opt-in\)/)).toBeNull();
    expect(screen.getByText('Auto-review')).toBeInTheDocument();
    const link = screen.getByRole('link', { name: 'Started by the autonomous run' });
    expect(link).toBeInTheDocument();
    // It stays on the open step and opens Project settings › Autopilot at the run log.
    expect(link).toHaveAttribute('href', '/music-video/p1/board?mvPanel=autopilot#mv-autonomous-run');
  });

  it('renders "Draft art direction and shots" in Production approvals', () => {
    const project = {
      id: 'p1',
      scenes: [],
      productionReview: {
        draft: {
          cast: '', environments: '', visualLanguage: '', motionLanguage: '', implementationPlan: '', storyboard: [],
        },
      },
    };
    const review = {
      readiness: {
        basis: {},
        art: { approved: false, problems: [] },
        storyboard: { approved: false, problems: [] },
        proof: { approved: false, problems: [] },
      },
      busy: false,
      proof: { active: false, occupied: false },
      prepare: vi.fn(),
      save: vi.fn(),
      reset: vi.fn(),
      approve: vi.fn(),
    };
    render(
      <ProductionReviewPanel
        project={project}
        review={review}
        onOpenArtifact={vi.fn()}
        stage="art"
      />
    );

    expect(screen.getByRole('button', { name: 'Draft art direction and shots' })).toBeInTheDocument();
    expect(screen.queryByText(/Prepare planning draft with autopilot/i)).toBeNull();
  });

  it('derives next actions using Autonomous run canonical name', () => {
    const stopped = { id: 'p', autonomousRun: { status: 'stopped' } };
    expect(deriveNextAction(stopped)).toMatchObject({
      id: 'resume-autonomous',
      kind: 'run',
      label: 'Resume autonomous run',
    });

    const failed = { id: 'p', autonomousRun: { status: 'failed' } };
    expect(deriveNextAction(failed)).toMatchObject({
      id: 'retry-autonomous',
      kind: 'run',
      label: 'Retry autonomous run',
    });
  });
});
