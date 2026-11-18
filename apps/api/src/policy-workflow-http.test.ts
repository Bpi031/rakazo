import { beforeEach, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
vi.mock('@rakazo/adapters', async () => ({ policyOwnerDecision: (await import('../../../../packages/adapters/src/policy-workflow.js')).policyOwnerDecision }));
import { mountPolicyWorkflow } from './policy-workflow-http.js';
let app:Hono, service:any, actor:any;
const identity={userId:'u',spaceId:'s',email:'manager@example.invalid',isDeploymentOwner:false};
const input={id:'a'.repeat(64),digest:'b'.repeat(64),decision:'approve',confirmed:true};
beforeEach(()=>{app=new Hono();service={get:vi.fn(async()=>({id:input.id})),decide:vi.fn(async()=>({status:'approved'}))};actor=vi.fn(async()=>identity);
  mountPolicyWorkflow(app,{service,actor,webOrigin:'https://test'});});
const post=(data:unknown=input,headers:Record<string,string>={})=>app.request('https://test/api/policy-workflow/decide',{
  method:'POST',headers:{origin:'https://test','content-type':'application/json',cookie:'session=synthetic',...headers},body:JSON.stringify(data)});
it('uses the signed-in manager session without password re-entry, never agent bearer',async()=>{
  for(const headers of [{origin:'https://evil'},{authorization:'Bearer agent'},{cookie:''}])expect((await post(input,headers)).status).toBe(403);
  expect(service.decide).not.toHaveBeenCalled();
  expect((await post()).status).toBe(200);expect(service.decide).toHaveBeenCalledWith(identity,input.id,input.digest,'approve');
});
it('bounds confirmation requests and never logs password/backend errors',async()=>{
  expect((await post({...input,password:'x'.repeat(5000)})).status).toBe(413);
  service.decide.mockRejectedValue(Error('secret-path'));
  const response=await post();expect(response.status).toBe(409);expect(await response.text()).not.toContain('secret-path');
  for(let i=0;i<3;i++)await post();expect((await post()).status).toBe(429);
});
it('rejects missing confirmation and signed-out reads',async()=>{
  expect((await post({...input,confirmed:false})).status).toBe(409);expect(service.decide).not.toHaveBeenCalled();
  actor.mockResolvedValue(null);expect((await post()).status).toBe(401);
  expect((await app.request('https://test/api/policy-workflow/review/'+input.id)).status).toBe(401);
});
it('rejects credential fields rather than retaining them in approval records',async()=>{
  expect((await post({...input,password:'not-needed'})).status).toBe(409);expect(service.decide).not.toHaveBeenCalled();
});
it('reads an authenticated review without applying it',async()=>{
  const response=await app.request('https://test/api/policy-workflow/review/'+input.id);
  expect(response.status).toBe(200);expect(response.headers.get('cache-control')).toBe('no-store');expect(service.decide).not.toHaveBeenCalled();
});
