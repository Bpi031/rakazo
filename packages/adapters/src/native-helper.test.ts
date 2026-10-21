import {expect,it,vi} from 'vitest';
const state=vi.hoisted(()=>({request:null as any,tool:vi.fn(async(..._args:any[])=>({text:'source'})),context:null as any,instructions:''}));
vi.mock('./native-control.js',()=>({NativeControl:class {
 async actor(){return {actor:{userId:'u',spaceId:'s'},run:{botId:'b',threadId:'t'}};}
 tool(...args:any[]){return state.tool(...args);}
}}));
vi.mock('./agent-workbench.js',()=>({AgentWorkbench:class {
 constructor(private deps:any){}
 async helper(_run:string,_execution:string,args:any){state.instructions=args.instructions;return this.deps.generate({message:args.task,instruction:args.instructions,modelId:'approved'});}
}}));
vi.mock('./codex-protocol.mjs',()=>({runtimeConfig:()=>({}),CodexProtocolRuntime:class {
 async *run(request:any,context:any){state.request=request;state.context=context;await request.nativeControl.tool('workspace_read',{path:'workspace/a.rost'});yield {type:'text',text:'Inspected source; review required'};yield {type:'usage',inputTokens:10,cacheReadTokens:2,outputTokens:4,totalTokens:16};}
}}));
import {nativeHelper} from './native-helper.js';
it('runs a tool-capable native worker with private read-only tools and attributable usage',async()=>{
 const result=await nativeHelper({prisma:{} as any,sandbox:{} as any},'r','e',{name:'Review',task:'Inspect the supplied policy'},async()=>({}),{runId:'r',botId:'b',userId:'u',spaceId:'s'} as any);
 expect(state.request.nativeWorker).toBe(true);expect(state.request.history).toEqual([]);
 expect(state.request.tools.map((t:any)=>t.name)).toEqual(['workspace_read','workspace_list']);
 expect(state.request.executeTool).toBeUndefined();expect(state.request.runHelper).toBeUndefined();
 expect(state.instructions).toContain('scoped read-only');expect(state.context.signal).toBeInstanceOf(AbortSignal);
 expect(result).toMatchObject({text:'Inspected source; review required',needsApproval:true,usage:{input_tokens:12,output_tokens:4,total_tokens:16}});
 for(let n=1;n<8;n++)await state.request.nativeControl.tool('workspace_read',{path:'workspace/a.rost'});
 await expect(state.request.nativeControl.tool('workspace_read',{path:'workspace/a.rost'})).rejects.toThrow('allowance');
});
