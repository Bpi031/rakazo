import { expect, it } from 'vitest';
import { normalizeRunError } from './run-error.js';

const issue={code:'invalid_value',path:['status'],values:['reserved','preparing','running','stopping','completed','stopped','failed','recovery_required'],message:'Invalid option'};
it.each([JSON.stringify([issue]),'ROST_JOB_WATCH_OBSERVATION: A supported owned-job status could not be read.'])(
  'classifies the monitoring failure without blaming provider or solver: %s', value => {
    const result=normalizeRunError(value);
    expect(result.summary).toBe('Rost job monitoring could not read the job status.');
    expect(result.details).toContain('not a model-provider failure');
    expect(result.details).toContain('does not establish feasibility or infeasibility');
  });
it.each([JSON.stringify([{...issue,path:['unrelated']}]),JSON.stringify([{...issue,values:['completed','running']}]),
  JSON.stringify([issue,issue]),JSON.stringify([{...issue,code:'too_big'}]),'unrelated error'])(
  'does not relabel unrelated validator/provider failures: %s', value => {
    expect(normalizeRunError(value).summary).toBe('The model provider returned an error.');
  });
