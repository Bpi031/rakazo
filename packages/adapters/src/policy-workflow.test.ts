import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { PolicyWorkflow, policyWorkflowInput, policyWorkflowInstruction } from './policy-workflow.js';
import { teamDigest } from './team-policy.js';
const actor = { userId:'u', spaceId:'s', email:'manager@example.invalid', isDeploymentOwner:false };
const input = { operation:'review', baseline:'workspace/case/old.rost', baselineWorkingDirectory:'workspace/case',
  policy:'workspace/case/new.rost', workingDirectory:'workspace/case', reason:'Review the new policy.', purpose:'new_policy' };
let db:any, service:PolicyWorkflow, snapshot:any, row:any, execute:any, role:string, computerId:string, diagnosis:any;
beforeEach(() => {
  vi.stubEnv('ROST_POLICY_REVIEW_MODE', 'owner_review');
  role='admin';computerId='c';row=null;snapshot={candidate:{sourceSha256:'a'.repeat(64)},baseline:{sourceSha256:'b'.repeat(64)},inputs:[]};
  diagnosis={status:'infeasible',snapshot:structuredClone(snapshot.baseline)};
  db={spaceMember:{findUnique:async()=>({organizationId:'org',member:{role}})},teamMemberControl:{findUnique:async()=>null},
    bot:{findFirstOrThrow:async({where}:any)=>{if(where.userId!=='u'||where.spaceId!=='s')throw Error('private');return {computerId,computer:{id:computerId,kind:'docker',state:'running',scope:'dedicated',providerRef:'container',homeKey:'b'}};}},
    run:{findUniqueOrThrow:async()=>({status:'running',trigger:'user',userId:'u',spaceId:'s',botId:'b',threadId:'t',sourceMessageId:'m'})},
    message:{findFirstOrThrow:vi.fn(async()=>({id:'m'}))},
    agentWorkbenchRecord:{findMany:async()=>row&&row.kind==='policy_owner_review'?[row]:[],findUnique:async({where}:any)=>row?.id===where.id?row:null,findFirstOrThrow:async({where}:any)=>{if(where.kind==='policy_diagnosis'&&where.id==='d'.repeat(64)&&where.userId==='u'&&where.spaceId==='s')return {payload:structuredClone(diagnosis),digest:teamDigest(diagnosis)};if(!row||where.userId!==row.userId||where.spaceId!==row.spaceId)throw Error('private');return structuredClone(row);},
      create:async({data}:any)=>{row=data;return row;},updateMany:async({where,data}:any)=>{if(row.status!==where.status||(where.digest&&row.digest!==where.digest)||(where.expiresAt&&row.expiresAt<=new Date()))return {count:0};Object.assign(row,data);return {count:1};}},
    teamAudit:{create:vi.fn(async()=>({}))}};
  db.$transaction=async(fn:any)=>fn(db);
  execute=vi.fn(async function*(_ref:any,request:any){const payload=JSON.parse(Buffer.from(request.argv[4],'base64').toString());
    yield {type:'stdout',data:JSON.stringify(payload.operation==='diagnose'?{status:'indeterminate',solveStarted:false}:snapshot)};yield {type:'exit',code:0};});
  service=new PolicyWorkflow({prisma:db,sandbox:{execute} as any});
});
afterEach(()=>vi.unstubAllEnvs());
it('manager chat starts no approval workflow for an ordinary unchanged-policy run',async()=>{
  vi.stubEnv('ROST_POLICY_REVIEW_MODE','manager_chat');
  expect(await service.agent('run','current',{operation:'current',policy:input.policy,workingDirectory:input.workingDirectory}))
    .toMatchObject({status:'not_required',separateApprovalRequired:false,policyApprovalGranted:false,computeAllowanceGranted:false,solveStarted:false});
  expect(execute).not.toHaveBeenCalled();expect(row).toBeNull();
  expect(policyWorkflowInstruction()).toContain('Do not create approval cards');
});
it('records manager-message-bound source checks without inventing approval and adopts exact revisions',async()=>{
  vi.stubEnv('ROST_POLICY_REVIEW_MODE','manager_chat');
  const result=await service.agent('run','check',input);
  expect(result).toMatchObject({status:'checked',separateApprovalRequired:false,policyApprovalGranted:false,backgroundSupported:true});
  expect(row.payload.receipt).toBeUndefined();expect(row.payload.review.managerRequest).toMatchObject({subject:'u',messageId:'m',runId:'run'});
  expect(db.message.findFirstOrThrow).toHaveBeenCalledWith(expect.objectContaining({where:{id:'m',threadId:'t',role:'user',thread:{userId:'u',spaceId:'s',botId:'b'}}}));
  expect(await service.agent('later','reuse',input)).toMatchObject({id:result.id,status:'checked',reusedReview:true,reusedApproval:false});
  expect(await service.agent('later','apply',{operation:'apply',id:result.id})).toMatchObject({adopted:true,policyApprovalGranted:false,solveStarted:false});
  await expect(service.decide(actor,result.id!,result.digest!,'approve')).rejects.toThrow('disabled');
  snapshot.candidate.sourceSha256='c'.repeat(64);
  await expect(service.agent('later','changed',{operation:'apply',id:result.id})).rejects.toThrow();
});
it('supports selected person changes in chat without an extra approval or diagnosis gate',async()=>{
  vi.stubEnv('ROST_POLICY_REVIEW_MODE','manager_chat');
  const {purpose,...paths}=input;
  const result=await service.agent('run','change',{...paths,operation:'amendment_review',changes:[{ruleId:'quota',personId:'Scott',action:'exclude'}]});
  expect(result).toMatchObject({status:'checked',policyApprovalGranted:false,backgroundSupported:true});
  expect(JSON.parse(Buffer.from(execute.mock.calls[0][1].argv[4],'base64').toString()).operation).toBe('capture_amendment');
  expect((await service.get(actor,result.id!)).approvalMode).toBe('manager_chat');
  vi.stubEnv('ROST_POLICY_REVIEW_MODE','owner_review');
  expect(await service.status(actor,result.id!)).toMatchObject({status:'review_required',policyApprovalGranted:false});
  await expect(service.agent('run','apply',{operation:'apply',id:result.id})).rejects.toThrow();
});
it('manager chat still requires a private manager and a direct owned message for revisions',async()=>{
  vi.stubEnv('ROST_POLICY_REVIEW_MODE','manager_chat');role='member';
  await expect(service.agent('run','blocked',input)).rejects.toThrow('manager');role='admin';
  db.run.findUniqueOrThrow=async()=>({status:'running',trigger:'routine',userId:'u',spaceId:'s',botId:'b'});
  await expect(service.agent('run','routine',input)).rejects.toThrow('direct');
  db.run.findUniqueOrThrow=async()=>({status:'running',trigger:'user',userId:'u',spaceId:'s',botId:'b'});
  await expect(service.agent('run','no-message',input)).rejects.toThrow('message');expect(row).toBeNull();
});
it('reuses a source approval across turns without another card or password',async()=>{
  const review=await proposed();await service.decide(actor,review.id,review.digest,'approve');
  expect(row.expiresAt).toBeNull();
  const later=await service.agent('later-run','new-review',input);
  expect(later).toMatchObject({id:review.id,status:'approved',reusedApproval:true,backgroundSupported:true});
  expect(await service.agent('later-run','current',{operation:'current',policy:input.policy,workingDirectory:input.workingDirectory}))
    .toMatchObject({id:review.id,status:'approved',reusedApproval:true});
  expect(await service.agent('later-run','apply',{operation:'apply',id:review.id}))
    .toMatchObject({adopted:true,backgroundSupported:true,solveStarted:false,computeAllowanceGranted:false});
  expect(db.teamAudit.create).toHaveBeenCalledTimes(1);
});
it('uses explicit person-amendment review, never disguises it as correction',async()=>{
  const {purpose,...paths}=input;
  const request={...paths,operation:'amendment_review',diagnosisId:'d'.repeat(64),changes:[{ruleId:'quota',personId:'Scott',action:'exclude'}]};
  expect(policyWorkflowInput.safeParse(request).success).toBe(true);
  const review=await service.agent('run','amendment',request);
  expect(row.payload.review).toMatchObject({kind:'amendment',purpose:'person_amendment'});
  expect(JSON.parse(Buffer.from(execute.mock.calls[0][1].argv[4],'base64').toString()).operation).toBe('capture_amendment');
  await expect(service.agent('run','before-approval',{operation:'apply',id:review.id})).rejects.toThrow('decision');
  const visible=await service.get(actor,review.id!);await service.decide(actor,visible.id,visible.digest,'approve');
  expect(await service.agent('r2','reuse',request)).toMatchObject({id:review.id,reusedApproval:true});
  snapshot.candidate.sourceSha256='e'.repeat(64);
  expect(await service.agent('r2','changed',{operation:'current',policy:input.policy,workingDirectory:input.workingDirectory}))
    .toMatchObject({status:'stale',policyApprovalGranted:false});
});
it('does not turn a technical approval-check failure into another approval demand',async()=>{
  const review=await proposed();await service.decide(actor,review.id,review.digest,'approve');
  execute.mockImplementation(async function*(){throw new Error('runtime unavailable');});
  expect(await service.agent('later','current',{operation:'current',policy:input.policy,workingDirectory:input.workingDirectory}))
    .toMatchObject({status:'verification_unavailable',policyApprovalGranted:false,solveStarted:false});
});
it('does not duplicate a pending identical amendment review',async()=>{
  const {purpose,...paths}=input;
  const request={...paths,operation:'amendment_review',diagnosisId:'d'.repeat(64),changes:[{ruleId:'quota',personId:'Scott',action:'quota',value:3}]};
  const first=await service.agent('r','first',request);
  expect(await service.agent('r2','second',request)).toMatchObject({id:first.id,status:'pending',reusedReview:true,policyApprovalGranted:false});
});
it('rejects an unbound or substituted amendment baseline',async()=>{
  const {purpose,...paths}=input;
  const request={...paths,operation:'amendment_review',changes:[{ruleId:'quota',personId:'Scott',action:'exclude'}]};
  await expect(service.agent('r','unbound',request)).rejects.toThrow('baseline');
  diagnosis.snapshot.sourceSha256='e'.repeat(64);
  await expect(service.agent('r','substituted',{...request,diagnosisId:'d'.repeat(64)})).rejects.toThrow('baseline');
});
it('accepts the exact approved baseline without demanding a new diagnosis',async()=>{
  const initial=await proposed();await service.decide(actor,initial.id,initial.digest,'approve');
  const sourceSnapshot=structuredClone(snapshot);
  const next={baseline:sourceSnapshot.candidate,candidate:{sourceSha256:'c'.repeat(64)},inputs:[]};
  execute.mockImplementation(async function*(_ref:any,request:any){const capture=JSON.parse(Buffer.from(request.argv[4],'base64').toString());
    yield {type:'stdout',data:JSON.stringify(capture.operation==='capture_amendment'?next:sourceSnapshot)};yield {type:'exit',code:0};});
  expect(await service.agent('r2','amend',{operation:'amendment_review',baseline:input.policy,baselineWorkingDirectory:input.workingDirectory,
    policy:'workspace/case/revised.rost',workingDirectory:input.workingDirectory,reason:'Selected person change',changes:[{ruleId:'quota',personId:'Scott',action:'exclude'}]}))
    .toMatchObject({status:'pending',policyApprovalGranted:false});
});
async function proposed(){await service.agent('run','effect',input);return service.get(actor,row.id);}
it('requires exact review fields and refuses model-supplied approval',()=>{
  expect(policyWorkflowInput.safeParse({operation:'approve'}).success).toBe(false);
  expect(policyWorkflowInput.safeParse({...input,password:'secret'}).success).toBe(false);
  for(const value of ['../policy.rost','/home/rakazo/workspace/a.rost','workspace/a/../b','workspace//a'])expect(policyWorkflowInput.safeParse({...input,policy:value}).success).toBe(false);
});
it('pins a review and records independent manager identity without changing policy or solving',async()=>{
  const review=await proposed();expect(review.status).toBe('pending');
  const receipt=await service.decide(actor,review.id,review.digest,'approve');
  expect(receipt).toMatchObject({status:'approved',policyApprovalGranted:true,contractApprovalGranted:false,relaxationAuthorityGranted:false,computeAllowanceGranted:false,solveStarted:false});
  expect(receipt.receipt.subject).toBe('u');expect(receipt.receipt.author).toBe('agent:b:run');
  expect(db.teamAudit.create).toHaveBeenCalledTimes(1);
  await service.decide(actor,review.id,review.digest,'approve');expect(db.teamAudit.create).toHaveBeenCalledTimes(1);
});
it.each(['source','input','computer'])('invalidates approval on %s drift',async(kind)=>{
  const review=await proposed();await service.decide(actor,review.id,review.digest,'approve');
  if(kind==='source')snapshot.candidate.sourceSha256='c'.repeat(64);
  if(kind==='input')snapshot.inputs.push({sha256:'d'.repeat(64)});
  if(kind==='computer')computerId='replacement';
  expect(await service.status(actor,review.id)).toMatchObject({status:'stale',policyApprovalGranted:false});
});
it('rejects nonmanagers, wrong users/spaces, tampering and stale decisions',async()=>{
  const review=await proposed();
  await expect(service.get({...actor,userId:'other'},review.id)).rejects.toThrow();
  await expect(service.get({...actor,spaceId:'other'},review.id)).rejects.toThrow();
  await expect(service.decide(actor,review.id,'0'.repeat(64),'approve')).rejects.toThrow();
  role='member';await expect(service.decide(actor,review.id,review.digest,'approve')).rejects.toThrow('manager');role='admin';
  row.payload.review.reason='tampered';await expect(service.get(actor,review.id)).rejects.toThrow('identity');
});
it('expires and never treats rejection as approval',async()=>{
  const review=await proposed();expect(await service.decide(actor,review.id,review.digest,'reject')).toMatchObject({status:'rejected',policyApprovalGranted:false});
  await expect(service.decide(actor,review.id,review.digest,'approve')).rejects.toThrow();
  row.status='pending';row.expiresAt=new Date(0);await expect(service.decide(actor,review.id,review.digest,'approve')).rejects.toThrow('expired');
});
it('allows only explicit finite diagnosis in direct turns; never offers solve',async()=>{
  for(const seconds of [0,301,Infinity,-1,1.5])expect(policyWorkflowInput.safeParse({operation:'diagnose',policy:input.policy,workingDirectory:input.workingDirectory,seconds}).success).toBe(false);
  expect(await service.agent('run','diagnose',{operation:'diagnose',policy:input.policy,workingDirectory:input.workingDirectory,seconds:30})).toMatchObject({status:'indeterminate',solveStarted:false});
  db.run.findUniqueOrThrow=async()=>({status:'running',trigger:'routine',userId:'u',spaceId:'s',botId:'b'});
  await expect(service.agent('run','another',input)).rejects.toThrow('direct');
});
it('returns evidence without selecting a strategy even when repair_options is empty',async()=>{
  vi.stubEnv('ROST_POLICY_REVIEW_MODE','manager_chat');
  execute.mockImplementation(async function*(){yield {type:'stdout',data:JSON.stringify({status:'infeasible',
    action:'Legacy ledger-only advice',repair_options:[],evidencePath:'workspace/d/diagnosis.json',snapshot:{}})};yield {type:'exit',code:0};});
  const request={operation:'diagnose',policy:input.policy,workingDirectory:input.workingDirectory,seconds:30};
  const result=await service.agent('run','round',request);
  expect(result).toMatchObject({status:'infeasible',repair_options:[],evidencePath:'workspace/d/diagnosis.json'});
  expect(result).not.toHaveProperty('continuation');
  expect(result.action).toContain('grants no policy or compute authority');
  const replay=await service.agent('run','round',request);
  expect(replay).toMatchObject({status:'completed',diagnosisStatus:'infeasible',evidencePath:'workspace/d/diagnosis.json'});
  expect(execute).toHaveBeenCalledTimes(1);
});
it('exposes read-only conflict recovery without letting the model supply identity or authority',async()=>{
  expect(policyWorkflowInput.safeParse({operation:'conflict_status'}).success).toBe(true);
  expect(policyWorkflowInput.safeParse({operation:'conflict_status',botId:'foreign'}).success).toBe(false);
  db.routine={findFirst:vi.fn(async()=>null)};
  expect(await service.agent('run','resume',{operation:'conflict_status'})).toMatchObject({status:'no_current_conflict',solveStarted:false});
  expect(execute).not.toHaveBeenCalled();
  role='member';await expect(service.agent('run','member',{operation:'conflict_status'})).rejects.toThrow('manager');
});
it('does not inject repair strategy in either authority mode',()=>{
  expect(policyWorkflowInstruction()).toBe('');
  vi.stubEnv('ROST_POLICY_REVIEW_MODE','manager_chat');
  const guidance=policyWorkflowInstruction();
  expect(guidance).toMatch(/never invent approval receipts/i);
  expect(guidance).not.toMatch(/IIS\/MUS|iterative repair|minimum-cost/);
});
it('refuses a correction without native diagnosis, or with unrelated static evidence',async()=>{
  await expect(service.agent('run','effect',{...input,purpose:'model_correction'})).rejects.toThrow('diagnosis');
  db.agentWorkbenchRecord.findFirstOrThrow=async()=>({payload:{status:'indeterminate',snapshot:{}},digest:'wrong'});
  await expect(service.agent('run','effect',{...input,purpose:'model_correction',diagnosisId:'d'.repeat(64)})).rejects.toThrow('baseline');
});
it('does not rerun a claimed diagnosis after a lost response',async()=>{
  const request={operation:'diagnose',policy:input.policy,workingDirectory:input.workingDirectory,seconds:30};
  await service.agent('run','effect',request);const count=execute.mock.calls.length;
  await service.agent('run','effect',request);expect(execute.mock.calls.length).toBe(count);
});
it('binds a correction to exact native diagnosis evidence, not a different baseline',async()=>{
  const evidence={status:'infeasible',snapshot:structuredClone(snapshot.baseline)};
  db.agentWorkbenchRecord.findFirstOrThrow=async()=>({payload:evidence,digest:teamDigest(evidence)});
  const result=await service.agent('run','correction',{...input,purpose:'model_correction',diagnosisId:'d'.repeat(64)});
  expect(result).toMatchObject({status:'pending',policyApprovalGranted:false,solveStarted:false});
  row=null;snapshot.baseline.sourceSha256='e'.repeat(64);
  await expect(service.agent('run','changed',{...input,purpose:'model_correction',diagnosisId:'d'.repeat(64)})).rejects.toThrow('baseline');
});
