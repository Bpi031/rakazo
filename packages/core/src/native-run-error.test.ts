import { expect, it } from 'vitest';
import { normalizeRunError } from './run-error.js';
it.each(['Native session already owned', 'ROST_NATIVE_SESSION_BUSY: Another owned agent turn is using this private session.'])(
  'classifies local ownership contention without blaming the provider: %s', details => {
    expect(normalizeRunError(details)).toMatchObject({summary:'Another agent turn was using this private session.'});
    expect(normalizeRunError(details).details).toContain('does not mean the roster solve failed');
  });
it('does not relabel unrelated provider failures', () => {
  expect(normalizeRunError('unrelated failure').summary).toBe('The model provider returned an error.');
});
