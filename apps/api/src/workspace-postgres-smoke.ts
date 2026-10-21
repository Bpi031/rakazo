// Disposable database only. No computer, license, provider or client data access.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createDb } from "@rakazo/db";
import { WorkspaceInsights } from "./workspace-insights.js";
if (process.env.ROST_DISPOSABLE_TEAM_DB !== "1" || !process.env.DATABASE_URL) throw new Error("Disposable database required");
const {prisma:db,pool}=createDb(process.env.DATABASE_URL);
const org="workspace-"+randomUUID(); const users=[org+"-owner",org+"-member",org+"-foreign"];
const actor=(n:number) => ({userId:users[n]!,spaceId:users[n]!+"-space",email:users[n]+"@example.invalid",isDeploymentOwner:false});
let checks=0;
try {
  for(const [n,id] of users.entries()) {
    await db.user.create({data:{id,name:"Fixture "+n,email:actor(n).email}});
    const organizationId=n===2?org+"-foreign":org;
    if(n!==1) await db.organization.create({data:{id:organizationId,name:"Fixture",slug:organizationId,createdAt:new Date()}});
    await db.member.create({data:{id:randomUUID(),organizationId,userId:id,role:n===1?"member":"owner",createdAt:new Date()}});
    await db.space.create({data:{id:actor(n).spaceId,name:"Private",organizationId,createdByUserId:id}});
    await db.spaceMember.create({data:{id:randomUUID(),organizationId,userId:id,spaceId:actor(n).spaceId,role:"owner",createdAt:new Date()}});
  }
  for(const n of [0,1,2]) await db.usageRecord.create({data:{userId:users[n]!,spaceId:actor(n).spaceId,model:"fixture",provider:"fixture",inputTokens:5,outputTokens:2,totalTokens:7,costUsd:n===1?null:0.1}});
  const service=new WorkspaceInsights(db,{} as any);
  const own=await service.usage(actor(1),new URLSearchParams()); assert.equal(own.totals.calls,1);assert.equal(own.totals.totalTokens,7);assert.equal(own.totals.costUsd,null);checks++;
  const selected=await service.usage(actor(0),new URLSearchParams({userId:users[1]!}));assert.equal(selected.userId,users[1]);assert.equal(selected.totals.calls,1);checks++;
  const filtered=await service.usage(actor(0),new URLSearchParams({model:"absent' OR TRUE --"}));assert.equal(filtered.totals.calls,0);checks++;
  assert.equal((await service.people(actor(1))).members.length,1);assert.equal((await service.people(actor(0))).members.length,2);checks++;
  await assert.rejects(service.usage(actor(1),new URLSearchParams({userId:users[0]!})));checks++;
  await assert.rejects(service.usage(actor(0),new URLSearchParams({userId:users[2]!})));checks++;
  await db.teamMemberControl.create({data:{organizationId:org,userId:users[1]!,state:"suspended"}});
  await assert.rejects(service.usage(actor(0),new URLSearchParams({userId:users[1]!})));checks++;
  console.log(JSON.stringify({status:"passed",checks,native_postgres:true,live_model_used:false}));
} finally {
  await db.organization.deleteMany({where:{id:{in:[org,org+"-foreign"]}}});
  await db.teamMemberControl.deleteMany({where:{organizationId:org}});
  await db.user.deleteMany({where:{id:{in:users}}}); await db.$disconnect();await pool.end();
}
