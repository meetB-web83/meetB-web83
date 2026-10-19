import { z } from 'zod';

/**
 * Query parameters arrive as strings over HTTP (`?include_superseded=true`). Accept the
 * literal strings "true"/"false" as well as real booleans from JSON callers. Zod's
 * `z.coerce.boolean()` is deliberately not used: it turns any non-empty string —
 * including "false" — into `true`.
 */
export const queryBoolean = z.preprocess(
  (value) => (value === 'true' ? true : value === 'false' ? false : value),
  z.boolean(),
);
