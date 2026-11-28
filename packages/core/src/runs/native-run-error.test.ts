import { expect, it } from 'vitest';
import { normalizeRunError } from "./run-error.js";
it.each(['Native session already owned', 'ROST_NATIVE_SESSION_BUSY: Another owned agent turn is using this private session.'])(
  'classifies local ownership contention without blaming the provider: %s', details => {
    expect(normalizeRunError(details)).toMatchObject({summary:'Another agent turn was using this private session.'});
    expect(normalizeRunError(details).details).toContain('does not mean the roster solve failed');
  });
it('does not relabel unrelated provider failures', () => {
  expect(normalizeRunError('unrelated failure').summary).toBe('The model provider returned an error.');
});
it.each([
  ['ROST_MODEL_OUTPUT_LIMIT', 'The model reached its output limit before finishing.'],
  ['ROST_MODEL_RESPONSE_FILTERED', 'The model service did not deliver a complete reply.'],
  ['ROST_MODEL_RESPONSE_INVALID', 'The model service returned a reply Rost could not use.'],
  ['ROST_MODEL_UNAVAILABLE', "Rost's model service is temporarily unavailable."],
  ['ROST_MODEL_CONTEXT_LIMIT', 'This request is too large for the model.'],
])('reports %s with a safe summary and no retry', (code, summary) => {
  const result = normalizeRunError(`${code}: private diagnostic`);
  expect(result.summary).toBe(summary);
  expect(result.details).toContain('No automatic retry');
  expect(result.details).not.toContain('private diagnostic');
});
