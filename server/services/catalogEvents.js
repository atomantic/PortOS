import { EventEmitter } from 'events';

// Progress for a user-triggered catalog extraction plan. Each frame carries
// the parent scrapId and runId so overlapping runs remain distinguishable;
// the plan supplies one stage per actual whole-source or chunk call.
export const catalogEvents = new EventEmitter();
