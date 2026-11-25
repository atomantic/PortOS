/** Load default-exported Express routers on demand and warm them after the server starts listening. */
import { warmModuleLoads } from './moduleWarmup.js';

const routerLoads = [];

export function createLazyRouter(load) {
  let pending;
  const getRouter = () => {
    pending ??= load().then(module => module.default).catch(error => {
      pending = undefined;
      throw error;
    });
    return pending;
  };
  routerLoads.push(['Lazy router', getRouter]);
  return async (req, res, next) => {
    const router = await getRouter();
    return router(req, res, next);
  };
}

export const warmLazyRouters = () => warmModuleLoads(routerLoads);
