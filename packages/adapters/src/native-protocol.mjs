import { createHash } from "node:crypto";

export const nativeReadNames = new Set(["workspace_read", "workspace_list", "ask_user", "ask_form"]);
export const digestNative = (v) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
export function boundedCapabilities(models, skills, requirements) {
  if (!Array.isArray(models?.data) || models.data.length > 100 || !Array.isArray(skills?.data) || skills.data.length > 8)
    throw new Error("Native capability response is incompatible");
  return { protocol: "0.144.5", models: models.data.map(m => ({ id: String(m.id ?? m.model).slice(0,128), efforts: (m.supportedReasoningEfforts ?? []).slice(0,8).map(e => String(e.reasoningEffort).slice(0,20)), inputModalities: (m.inputModalities ?? []).filter(s => ["text","image"].includes(s)) })),
    skills: skills.data.flatMap(c => (c.skills ?? []).slice(0,64).map(s => ({ name: String(s.name).slice(0,100), description: String(s.description ?? '').slice(0,300), enabled: s.enabled === true }))).slice(0,64),
    requirementsPresent: requirements?.requirements != null,
    qualifiedByOperator: false };
}
export function safeNativeDiff(value) {
  if (typeof value !== 'string') throw new Error('Invalid native diff');
  const sha256=digestNative(value);
  if(Buffer.byteLength(value)>64000 || /(?:^|\n)(?:diff --git|---|\+\+\+) .*?(?:\.env|\.lic|secret|credential|\/\.\.)/i.test(value)) return {sha256,redacted:true,diff:null};
  const headers=[...value.matchAll(/^(?:---|\+\+\+) (.+)$/gm)].map(m=>m[1]);
  if(!headers.length || headers.some(p=>p!=='/dev/null'&&(!/^[ab]\/workspace\//.test(p)||p.slice(2).split('/').some(s=>!s||s==='..'||s.startsWith('.')))))return {sha256,redacted:true,diff:null};
  return {sha256,redacted:false,diff:value,policyApprovalGranted:false};
}
export function usageDelta(current, previous) {
  if(!previous)return current;
  const result={};
  for(const name of ['inputTokens','cachedInputTokens','outputTokens','reasoningOutputTokens','totalTokens']) {
    const a=current?.[name],b=previous?.[name];
    result[name]=Number.isSafeInteger(a)&&Number.isSafeInteger(b)&&a>=b?a-b:null;
  }
  return result;
}
export const completionOutputSchema={type:'object',additionalProperties:false,required:['schema','kind','outcome','message','deliverables','evidence'],properties:{schema:{type:'string',enum:['rakazo/completion/v1']},kind:{type:'string',enum:['answer','artifacts']},outcome:{type:'string',enum:['complete','blocked','needs_review']},message:{type:'string'},deliverables:{type:'array',maxItems:12,items:{type:'object',additionalProperties:false,required:['path','sha256'],properties:{path:{type:'string'},sha256:{type:'string'}}}},evidence:{type:'array',maxItems:12,items:{type:'object',additionalProperties:false,required:['kind','path','sha256'],properties:{kind:{type:'string',enum:['validation','readback','diagnosis']},path:{type:'string'},sha256:{type:'string'}}}}}};
