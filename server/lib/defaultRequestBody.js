// Express 5 leaves req.body undefined when a request has no parsable body, so
// handlers destructuring it would throw a TypeError 500. Default it once here.
export function defaultRequestBody(req, _res, next) {
  if (req.body === undefined) req.body = {};
  next();
}
