import { expect, it } from 'vitest';
import { runtimeInstructionContext } from './executor.js';
const parts = { botInstructions:'Stable owner restrictions',groupContext:undefined,messagingContext:undefined,
  redactedMemoryContext:'memory one',redactedScratchpadContext:'step one',hasHistoricalContext:false,
  computerInstruction:'Private home only',pageBrowserAllowed:false,workspaceInstruction:'Workspace',
  agentEnvironmentInstruction:undefined,botDirectory:'bot A',pluginLine:undefined,agentSkillsLine:undefined,taughtSkillsLine:undefined,replyGuidance:'Brief' };
it('keeps live memory in each turn while excluding it from resume compatibility',()=>{
  const one=runtimeInstructionContext(parts),two=runtimeInstructionContext({...parts,redactedMemoryContext:'memory two',redactedScratchpadContext:'step two',botDirectory:'bot B',hasHistoricalContext:true});
  expect(one.sessionInstructions).toBe(two.sessionInstructions);expect(one.instructions).not.toBe(two.instructions);
  expect(two.instructions).toContain('step two');expect(two.sessionInstructions).not.toContain('step two');
});
it('changes compatibility when actual authority or computer restrictions change',()=>{
  const first=runtimeInstructionContext(parts);
  expect(runtimeInstructionContext({...parts,botInstructions:'Different permissions'}).sessionInstructions).not.toBe(first.sessionInstructions);
  expect(runtimeInstructionContext({...parts,computerInstruction:'Different workspace'}).sessionInstructions).not.toBe(first.sessionInstructions);
});
