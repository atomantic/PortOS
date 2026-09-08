import { expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import VideoCutPanel from './VideoCutPanel.jsx';

it('plays and downloads the stored Timeline filename and distinguishes a reviewed cut from delivery', () => {
  const project = { status: 'stitching', collectionId: 'example-collection', timelineProjectId: 'example-timeline', videoRoughCut: { videoId: 'example-job', filename: 'timeline-example-cut.mp4', durationSeconds: 60, audioMode: 'silent' } };
  const { container, rerender } = render(<MemoryRouter><VideoCutPanel project={project} /></MemoryRouter>);
  expect(screen.getByText('Cut awaiting review')).toBeInTheDocument();
  expect(container.querySelector('video')).toHaveAttribute('src', '/data/videos/timeline-example-cut.mp4');
  expect(screen.getByRole('link', { name: 'Download cut' })).toHaveAttribute('href', '/data/videos/timeline-example-cut.mp4');
  expect(screen.getByRole('link', { name: 'Open in Media History' })).toHaveAttribute('href', '/media/history?preview=timeline-example-cut.mp4');
  expect(screen.getByRole('link', { name: 'Open in Timeline' })).toHaveAttribute('href', '/media/timeline/example-timeline');
  rerender(<MemoryRouter><VideoCutPanel project={{ ...project, status: 'complete', finalVideoId: 'example-job', videoFinalCut: project.videoRoughCut }} /></MemoryRouter>);
  expect(screen.getByText('Final video')).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Download final video' })).toBeInTheDocument();
  fireEvent.error(container.querySelector('video'));
  expect(screen.getByRole('button', { name: /Retry/ })).toBeInTheDocument();
});
