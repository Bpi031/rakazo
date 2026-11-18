// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it } from 'vitest';
import { answeredFields, AnsweredForm } from './AnsweredForm';
const form = { schema: 'rakazo/question-form/v1' as const, fields: [
  { id: 'choice', label: 'Saturday rounds', type: 'choice' as const, required: true, options: ['Respect mandatory restrictions', 'Keep existing rule'] },
] };
const answer = JSON.stringify({ schema: 'rakazo/question-answer/v1', values: { choice: form.fields[0]!.options[0] } });
it('decodes recorded labels and selected values without changing the protocol answer', () => {
  expect(answeredFields(form, answer)).toEqual([{ id: 'choice', label: 'Saturday rounds', value: 'Respect mandatory restrictions' }]);
  expect(JSON.parse(answer).schema).toBe('rakazo/question-answer/v1');
});
it.each(['not-json', '{"schema":"wrong","values":{}}', JSON.stringify({ schema:'rakazo/question-answer/v1',values:{choice:'forged'} })])('does not display malformed raw JSON %s', bad => {
  expect(answeredFields(form, bad)).toBeNull();
});
it('renders human text and escapes text content', async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement('div'); const root = createRoot(host);
  await act(async () => root.render(<AnsweredForm question="Decision" form={form} answer={answer} />));
  expect(host.textContent).toContain('Respect mandatory restrictions');
  expect(host.textContent).not.toContain('rakazo/question-answer');
  await act(async () => root.unmount());
});
