// Requires a disposable migrated DB. No live model, supervisor or solver is called.
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {createDb, createRepos} from "@rakazo/db";
import {createRunExecutor} from "./executor.js";
import {createRostJobWatch} from "./rost-job-watch.js";

if (process.env.ROST_DISPOSABLE_TEAM_DB !== "1" || !process.env.DATABASE_URL)
  throw new Error("Explicit disposable database required");
const {prisma:db,pool}=createDb(process.env.DATABASE_URL);
const org="watch-"+randomUUID(), userId=org+"-owner", spaceId=org+"-space";
const actor={userId,spaceId,email:userId+"@example.invalid",isDeploymentOwner:false};
let checks=0,status="running",failQueue=false;
try {
  await db.user.create({data:{id:userId,name:"Disposable watch owner",email:actor.email,emailVerified:true}});
  await db.organization.create({data:{id:org,name:"Disposable",slug:org,createdAt:new Date()}});
  await db.member.create({data:{id:randomUUID(),organizationId:org,userId,role:"owner",createdAt:new Date()}});
  await db.space.create({data:{id:spaceId,organizationId:org,name:"Private",createdByUserId:userId}});
  await db.spaceMember.create({data:{id:randomUUID(),spaceId,organizationId:org,userId,role:"owner",createdAt:new Date()}});
  const bot=await createRepos(db).createBot(actor,{name:"Offline",title:"",description:"",instructions:"",notifyOnFinish:false,computerMode:"dedicated"});
  const thread=await db.thread.findFirstOrThrow({where:{botId:bot.id}});
  const computer=await db.computer.create({data:{userId,spaceId,scope:"dedicated",scopeKey:randomUUID(),homeKey:randomUUID(),kind:"docker",providerRef:"offline",state:"running"}});
  await db.bot.update({where:{id:bot.id},data:{computerId:computer.id}});
  const observation={binding:"a".repeat(64),deadlineUtc:Date.now()/1000+21600};
  let reads=0;
  const deps:any={prisma:db,sandbox:{async *execute(){reads++; yield {type:"stdout",data:JSON.stringify({...observation,status})};yield {type:"exit",code:0};}},
    jobs:{enqueue:async()=>{if(failQueue)throw new Error("queue unavailable");},cancel:async()=>{},close:async()=>{}},events:{append:async()=>{}}};
  const watch=await createRostJobWatch(deps,{...actor,botId:bot.id},"case/job",thread.id);
  const due=new Date(Date.now()-1000);
  const routine=await db.routine.create({data:{userId,spaceId,botId:bot.id,threadId:thread.id,
    name:"Offline completion",prompt:"Validate and export only this existing result",crons:["* * * * *"],active:true,nextRunAt:due,jobWatch:watch}});
  const executor=createRunExecutor(deps);
  await executor.wakeRoutine(routine.id,due.toISOString());
  assert.equal(await db.run.count({where:{botId:bot.id}}),0);checks++;
  assert.equal(await db.task.count({where:{botId:bot.id}}),0);checks++;
  let saved=await db.routine.findUniqueOrThrow({where:{id:routine.id}});
  assert.equal((saved.jobWatch as any).checks,1);assert.equal(saved.lastRunAt,null);checks++;
  await assert.rejects(db.routine.create({data:{userId,spaceId,botId:bot.id,name:"Duplicate",prompt:"no",crons:["* * * * *"],active:true,jobWatch:watch}}));checks++;
  await assert.rejects(createRostJobWatch(deps,{userId:"foreign",spaceId,botId:bot.id},"case/job"));checks++;
  status="completed";
  await db.routine.update({where:{id:routine.id},data:{nextRunAt:due}});
  failQueue=true;
  await assert.rejects(executor.wakeRoutine(routine.id,due.toISOString()),/queue unavailable/);checks++;
  saved=await db.routine.findUniqueOrThrow({where:{id:routine.id}});
  assert.equal(saved.active,false);assert.equal((saved.jobWatch as any).wakeReason,"completion");checks++;
  failQueue=false;
  await Promise.all(Array.from({length:4},()=>executor.wakeRoutine(routine.id,due.toISOString())));
  assert.equal(await db.run.count({where:{botId:bot.id}}),1);checks++;
  const run=await db.run.findFirstOrThrow({where:{botId:bot.id}});
  assert.equal(run.status,"queued");assert.equal(run.routineId,routine.id);checks++;
  assert.equal(await db.usageRecord.count({where:{botId:bot.id}}),0);checks++;
  assert.ok(reads>=3);checks++;
  console.log(JSON.stringify({status:"passed",checks,model_calls:0,solver_calls:0,disposable_database:true}));
} finally {
  await db.organization.deleteMany({where:{id:org}});
  await db.user.deleteMany({where:{id:userId}});
  await db.$disconnect();await pool.end();
}
