/** Readiness fixtures: a section with the server's `problems` sentences and their coded `problemItems`. */
export const problem = (code, message, sceneId) => ({ code, message, ...(sceneId ? { sceneId } : {}) });
export const withProblems = (section, items) => ({ ...section, problems: items.map((i) => i.message), problemItems: items });
