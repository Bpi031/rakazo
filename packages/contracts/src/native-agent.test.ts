import {expect,it} from 'vitest';
import {CompletionReceipt,NativeDecision} from './native-agent.js';
const claim={schema:'rakazo/completion/v1',kind:'artifacts',outcome:'complete',message:'Draft',deliverables:[{path:'workspace/draft.xlsx',sha256:'a'.repeat(64)}],evidence:[]};
it('requires concrete bounded artifact claims without approval fields',()=>{
  expect(CompletionReceipt.parse(claim)).toEqual(claim);
  for(const bad of [{...claim,deliverables:[]},{...claim,approved:true},{...claim,deliverables:[{path:'../other/draft.xlsx',sha256:'a'.repeat(64)}]},{...claim,deliverables:[{path:'workspace/draft.xlsx',sha256:'not-a-hash'}]}])expect(()=>CompletionReceipt.parse(bad)).toThrow();
});
it('native preferences cannot carry a solve allowance or cross-user path',()=>{
 const value={operation:'native_settings',botId:'own',revision:0,preferences:{mode:'plan',persistence:true,action:'none'}};
 expect(NativeDecision.parse(value)).toEqual(value);
 expect(()=>NativeDecision.parse({...value,seconds:7200})).toThrow();
 expect(()=>NativeDecision.parse({...value,preferences:{...value.preferences,workspace:'/other'}})).toThrow();
});
