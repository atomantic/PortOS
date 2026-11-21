/** Load a default-exported Express router on its first matching request, sharing the import across concurrent requests. */
export function createLazyRouter(load) {
  let pending;
  return async (req, res, next) => {
    pending ??= load().then(module => module.default).catch(error => {
      pending = undefined;
      throw error;
    });
    const router = await pending;
    return router(req, res, next);
  };
}
