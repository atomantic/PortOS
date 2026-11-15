// Express 5 leaves req.body undefined when a request has no parsable body, so
// handlers destructuring it would throw a TypeError 500. Default it once here.
//
// Express middleware that defaults an undefined `req.body` (Express 5 leaves it unset for body-less
// requests) to `{}` so handlers do not crash with a TypeError 500.
export function defaultRequestBody(req, _res, next) {
  if (req.body === undefined) req.body = {};
  next();
}
