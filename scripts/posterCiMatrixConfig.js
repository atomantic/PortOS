export const POSTER = 'services/codeAnimation/poster.realBrowser.test.js';

export function withPosterPlacement(config, placement) {
  if (!['parallel', 'capture'].includes(placement)) throw Error('Invalid poster placement');
  const projects = config.test.projects.map(project => ({ ...project, test: { ...project.test } }));
  const parallel = projects.find(project => project.test.name === 'parallel');
  const capture = projects.find(project => project.test.name === 'capture');
  if (!parallel || !capture || !parallel.test.exclude.includes(POSTER) || !capture.test.include.includes(POSTER)) {
    throw Error('Poster must be selected in the existing capture policy');
  }
  if (placement === 'parallel') {
    parallel.test.exclude = parallel.test.exclude.filter(path => path !== POSTER);
    capture.test.include = capture.test.include.filter(path => path !== POSTER);
  }
  return { ...config, test: { ...config.test, projects } };
}

