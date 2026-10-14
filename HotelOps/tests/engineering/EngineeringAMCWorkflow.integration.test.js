const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');

test('AMC migration preserves legacy data; Builder snapshots, actions and equipment synchronization',{
 skip:process.env.AMC_WORKFLOW_DB_TEST!=='1',timeout:180000
},async()=>{
 const {pool}=require('../../db');
 const workflow=require('../../services/EngineeringService/EngineeringAMCWorkflow');
 const read=require('../../services/EngineeringService/EngineeringAMCWorkflowRead');
 const builder=require('../../services/FlowBuilderService/ApprovalFlowService');
 const client=await pool.connect();
 const originalQuery=pool.query,originalConnect=pool.connect;
 let queue=Promise.resolve();const sent=[],deliveries=[];
 const query=(...args)=>{const result=queue.then(()=>client.query(...args));queue=result.catch(()=>{});return result;};
 const drain=async()=>{await new Promise(resolve=>setImmediate(resolve));await queue;await Promise.all(deliveries);};
 try {
  await client.query('BEGIN');await client.query("SET LOCAL lock_timeout='5s'");
  const original=(await client.query('SELECT to_jsonb(a) AS row FROM engineering_amc_approval a ORDER BY amcid')).rows.map(r=>r.row);
  const legacySource={engineering_amc_approval:original,
    engineering_amc_master:(await client.query('SELECT to_jsonb(m) AS row FROM engineering_amc_master m ORDER BY amcid')).rows.map(r=>r.row),
    engineering_amc_approval_config:(await client.query('SELECT to_jsonb(c) AS row FROM engineering_amc_approval_config c ORDER BY amcapprovalconfigid')).rows.map(r=>r.row)};
  const {expectedStates}=require('../../scripts/migrateAMCWorkflow');
  const present=(await client.query("SELECT to_regclass('public.engineering_amc_workflow_step') IS NOT NULL AS present")).rows[0].present;
  const priorSteps=present?(await client.query('SELECT * FROM engineering_amc_workflow_step ORDER BY amcid,level')).rows:[];
  const priorStates=expectedStates(legacySource,priorSteps);
  const equipmentBefore=(await client.query('SELECT to_jsonb(e) AS row FROM engineering_equipment_entry_master e ORDER BY equipmentid')).rows;
  const migration=fs.readFileSync(path.resolve(__dirname,'../../docs/migrations/amc-dynamic-workflow.sql'),'utf8').replace(/^BEGIN;|^COMMIT;/gm,'');
  await client.query(migration);
  assert.deepEqual(expectedStates(legacySource,(await client.query('SELECT * FROM engineering_amc_workflow_step ORDER BY amcid,level')).rows),priorStates);
  const approvalAfter=async()=> (await client.query('SELECT to_jsonb(a) AS row FROM engineering_amc_approval a ORDER BY amcid')).rows.map(({row})=>{
   const copy={...row};if(!Object.hasOwn(original[0]||{},'approvalmasterid'))delete copy.approvalmasterid;
   if(!Object.hasOwn(original[0]||{},'flowname'))delete copy.flowname;return copy;
  });
  assert.deepEqual(await approvalAfter(),original,'Migration must not alter any stored approval fields');
  assert.deepEqual((await client.query('SELECT to_jsonb(e) AS row FROM engineering_equipment_entry_master e ORDER BY equipmentid')).rows,equipmentBefore);
  const integrity=await client.query(`SELECT COUNT(*)::int AS invalid FROM engineering_amc_workflow_step s
    JOIN engineering_amc_approval a USING(amcid) WHERE a.approvalmasterid IS NULL AND (
      s.status IS DISTINCT FROM COALESCE(to_jsonb(a)->>(lower(s.role)||'status'),'Pending')
      OR s.remarks IS DISTINCT FROM to_jsonb(a)->>(lower(s.role)||'remarks')
      OR s.actionby IS DISTINCT FROM (to_jsonb(a)->>(lower(s.role)||'statusapprovedby'))::bigint
      OR s.actiondatetime IS DISTINCT FROM (to_jsonb(a)->>(lower(s.role)||'statusdatetime'))::timestamp)`);
  assert.equal(integrity.rows[0].invalid,0);
  const frozen=(await client.query('SELECT to_jsonb(s) AS row FROM engineering_amc_workflow_step s ORDER BY stepid')).rows;
  await client.query(migration);
  assert.deepEqual((await client.query('SELECT to_jsonb(s) AS row FROM engineering_amc_workflow_step s ORDER BY stepid')).rows,frozen);
  assert.deepEqual(await approvalAfter(),original);
  const amc=(await client.query(`SELECT m.*,e.departmentid,e.description FROM engineering_amc_master m
    JOIN engineering_equipment_entry_master e USING(equipmentid) WHERE NOT m.isdeleted AND NOT e.isdeleted ORDER BY m.amcid LIMIT 1`)).rows[0];
  assert.ok(amc,'Existing AMC fixture required');
  const creator=(await client.query(`SELECT u.userid FROM user_master u JOIN user_org_mapping member USING(userid)
    WHERE member.organizationid=$1 AND member.isactive AND NOT member.isdeleted
      AND u.isactive AND NOT u.isdeleted AND NOT u.islocked ORDER BY u.userid LIMIT 1`,[amc.organizationid])).rows[0];
  const regional=(await client.query(`SELECT um.userid FROM user_master um JOIN organization_master om ON om.organizationid=$1
    WHERE um.isactive AND NOT um.isdeleted AND NOT um.islocked AND um.userid<>$2
      AND ${workflow.regionalEligibilitySQL()} ORDER BY um.userid LIMIT 1`,[amc.organizationid,creator.userid])).rows[0];
  assert.ok(regional,'Regional company-primary user fixture required');
  const flow=(await client.query(`SELECT * FROM approval_master WHERE organizationid=$1 AND UPPER(TRIM(modulename)) IN ('AMC','AMC RENEWAL')
    AND isactive AND NOT isdelete`,[amc.organizationid])).rows[0];
  const adapter={release(){},query:(sql,values)=>query(sql==='BEGIN'?'SAVEPOINT service_test'
    :sql==='COMMIT'?'RELEASE SAVEPOINT service_test':sql==='ROLLBACK'?'ROLLBACK TO SAVEPOINT service_test':sql,values)};
  pool.query=query;pool.connect=async()=>adapter;
  const details=[
   {Level:1,ApproverType:'REGIONAL',Role:String(regional.userid),ApprovalType:'REGIONAL REVIEW',IsMandatory:true},
   {Level:2,ApproverType:'ROLE',Role:'FC',ApprovalType:'FC',IsMandatory:false},
   {Level:3,ApproverType:'USER',Role:String(creator.userid),ApprovalType:'GM',IsMandatory:true},
  ];
  const saved=await builder.saveApprovalFlow({OrganizationID:amc.organizationid,ApprovalMasterID:flow.approvalmasterid,
   FlowName:'AMC reordered test',ModuleName:'AMC',Details:details.slice().reverse(),UserID:creator.userid});
  assert.equal(saved.success,true,saved.message);
  assert.deepEqual((await query('SELECT to_jsonb(s) AS row FROM engineering_amc_workflow_step s ORDER BY stepid')).rows,frozen);
  await query('UPDATE user_org_mapping SET isactive=FALSE WHERE userid=$1 AND organizationid=$2',[regional.userid,amc.organizationid]);
  const file=path.resolve(__dirname,'../../services/EngineeringService/EngineeringService.js');
  const context={module:{exports:{}},process,Buffer,console:{log(){},error(...args){console.error(...args);}},setTimeout,clearTimeout};
  context.require=name=>name==='./EngineeringAMCApprovalNotificationService'?{
    notifyCommittedAMCApproval:event=>deliveries.push(require('../../services/EngineeringService/EngineeringAMCApprovalNotificationService')
      .notifyAMCApproval({...event,queryable:{query},publishNotification:async(data)=>{
        sent.push({action:'CREATE_NOTIFICATION',data});return {success:true};
      }})),
  }:name==='../../producer/producer'?{sendMessage:async()=>assert.fail('Unexpected external notification')}
    :require(name.startsWith('.')?path.resolve(path.dirname(file),name):name);
  vm.runInNewContext(fs.readFileSync(file,'utf8'),context);
  const service=context.module.exports;
  const create=async()=>{
   const result=await service.createAMC({OrganizationID:amc.organizationid,EquipmentID:amc.equipmentid,
    UserID:creator.userid,AMCStartDate:'2026-10-01',AMCEndDate:'2027-10-01',AMCType:'Comprehensive',AMCAmount:1234});
   assert.equal(result.success,true,result.message);await drain();
   return (await query('SELECT * FROM engineering_amc_master WHERE organizationid=$1 ORDER BY amcid DESC LIMIT 1',[amc.organizationid])).rows[0];
  };
  const record=await create();
  assert.deepEqual(Array.from(sent.at(-1).data.userIds),[String(regional.userid)]);
  const steps=await workflow.loadSteps(client,record.amcid);
  assert.deepEqual(steps.map(s=>s.approvaltype),details.map(s=>s.ApprovalType));
  const creatorDetail=await service.getAMCById({AMCID:record.amcid,EquipmentID:record.equipmentid,UserID:creator.userid});
  assert.equal(creatorDetail.data.CanEdit,true);assert.equal(creatorDetail.data.CanDelete,true);
  const deniedEdit=await service.updateAMC({AMCID:record.amcid,OrganizationID:record.organizationid,
    UserID:regional.userid,Changes:{VendorName:'Unauthorized'}});
  assert.equal(deniedEdit.statusCode,403);
  const deniedDelete=await service.deleteAMC({AMCID:record.amcid,UserID:regional.userid});
  assert.equal(deniedDelete.statusCode,403);
  const edit=await service.updateAMC({AMCID:record.amcid,OrganizationID:record.organizationid,
    UserID:creator.userid,Changes:{VendorName:'Creator edited before approval'}});
  assert.equal(edit.success,true,edit.message);
  const gm=(await query(`SELECT um.userid FROM user_master um JOIN user_org_mapping member USING(userid)
    WHERE member.organizationid=$1 AND member.isactive AND NOT member.isdeleted AND UPPER(TRIM(um.usertype))='GM'
      AND um.isactive AND NOT um.isdeleted AND NOT um.islocked AND um.userid<>$2 LIMIT 1`,[record.organizationid,creator.userid])).rows[0];
  assert.ok(gm);
  const ractor=await workflow.getActor(client,record.organizationid,regional.userid,record.amcid);
  assert.equal(ractor.organizationaccess,false);assert.equal(ractor.regionaleligible,true);
  const detail=await service.getAMCById({AMCID:record.amcid,EquipmentID:record.equipmentid,UserID:regional.userid});
  assert.equal(detail.success,true,detail.message);assert.equal(detail.data.CanApprove,true);
  const list=await service.getAllAMC({OrganizationID:record.organizationid,EquipmentID:record.equipmentid,Status:'Pending',UserID:regional.userid});
  assert.equal(list.success,true,list.message);assert.ok(list.data.data.some(r=>r.AMCID===Number(record.amcid)));
  const eqBefore=(await query('SELECT to_jsonb(e) AS row FROM engineering_equipment_entry_master e WHERE equipmentid=$1',[record.equipmentid])).rows[0];
  const first=await service.processAMCApproval({AMCID:record.amcid,UserID:regional.userid,Action:'APPROVE',ApprovalStepID:steps[0].stepid,Revision:0});
  assert.equal(first.success,true,first.message);await drain();
  assert.deepEqual(Array.from(sent.at(-1).data.userIds),[String(creator.userid)]);
  const active=await service.getAMCById({AMCID:record.amcid,EquipmentID:record.equipmentid,UserID:creator.userid});
  assert.equal(active.data.CanApprove,true);assert.equal(active.data.CanEdit,false);assert.equal(active.data.CanDelete,false);
  assert.deepEqual(Array.from(active.data.AllowedActions),['APPROVE','REJECT','RETURN']);
  const wrongGM=await service.getAMCById({AMCID:record.amcid,EquipmentID:record.equipmentid,UserID:gm.userid});
  assert.equal(wrongGM.statusCode,404);
  const gmAction=await service.processAMCApproval({AMCID:record.amcid,UserID:gm.userid,Action:'APPROVE',ApprovalStepID:steps[2].stepid});
  assert.equal(gmAction.statusCode,403);
  const lockedEdit=await service.updateAMC({AMCID:record.amcid,OrganizationID:record.organizationid,
    UserID:creator.userid,Changes:{VendorName:'Not permitted after approval'}});
  assert.equal(lockedEdit.statusCode,403);
  const lockedDelete=await service.deleteAMC({AMCID:record.amcid,UserID:creator.userid});
  assert.equal(lockedDelete.statusCode,403);
  assert.deepEqual((await query('SELECT to_jsonb(e) AS row FROM engineering_equipment_entry_master e WHERE equipmentid=$1',[record.equipmentid])).rows[0],eqBefore);
  const stale=await service.processAMCApproval({AMCID:record.amcid,UserID:creator.userid,Action:'APPROVE',ApprovalStepID:steps[2].stepid,Revision:9});
  assert.equal(stale.statusCode,409);
  const final=await service.processAMCApproval({AMCID:record.amcid,UserID:creator.userid,Action:'APPROVE',ApprovalStepID:steps[2].stepid,Revision:0});
  assert.equal(final.success,true,final.message);await drain();
  assert.deepEqual(Array.from(sent.at(-1).data.userIds),[String(creator.userid)]);
  const equipment=(await query('SELECT amctype,amcyearlyexpense,amcstatus FROM engineering_equipment_entry_master WHERE equipmentid=$1',[record.equipmentid])).rows[0];
  assert.equal(equipment.amctype,'Comprehensive');assert.equal(Number(equipment.amcyearlyexpense),1234);
  assert.equal(equipment.amcstatus,'Under AMC');
  assert.equal((await query('SELECT COUNT(*)::int AS count FROM engineering_amc_workflow_action a JOIN engineering_amc_workflow_step s USING(stepid) WHERE s.amcid=$1',[record.amcid])).rows[0].count,2);
  for(const Action of ['REJECT','RETURN']) {
   const row=await create();const ss=await workflow.loadSteps(client,row.amcid);
   const result=await service.processAMCApproval({AMCID:row.amcid,UserID:regional.userid,Action:Action,Remarks:'Reviewed',ApprovalStepID:ss[0].stepid});
   assert.equal(result.success,true,result.message);await drain();
   assert.deepEqual(Array.from(sent.at(-1).data.userIds),[String(creator.userid)]);
   const repeat=await service.processAMCApproval({AMCID:row.amcid,UserID:regional.userid,Action:'APPROVE',ApprovalStepID:ss[0].stepid});
   assert.equal(repeat.statusCode,403);
  }
  const deletable=await create();
  const deleted=await service.deleteAMC({AMCID:deletable.amcid,UserID:creator.userid});
  assert.equal(deleted.success,true,deleted.message);
  assert.equal((await query('SELECT isdeleted FROM engineering_amc_master WHERE amcid=$1',[deletable.amcid])).rows[0].isdeleted,true);
  // Optional-only flow is finalized and equipment synchronization remains atomic.
  const optional=await builder.saveApprovalFlow({OrganizationID:amc.organizationid,ApprovalMasterID:flow.approvalmasterid,
   FlowName:'AMC optional test',ModuleName:'AMC',Details:details.map(d=>({...d,IsMandatory:false})),UserID:creator.userid});
  assert.equal(optional.success,true,optional.message);
  const automatic=await create();
  assert.equal((await query('SELECT finalstatus FROM engineering_amc_approval WHERE amcid=$1',[automatic.amcid])).rows[0].finalstatus,'Approved');
 } finally {
  await drain();pool.query=originalQuery;pool.connect=originalConnect;
  await client.query('ROLLBACK');client.release();await pool.end();
 }
});
