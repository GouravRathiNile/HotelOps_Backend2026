const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
test('PostgreSQL OPEX configured stages, actions, optional stages, legacy reads and isolation',{
 skip:process.env.OPEX_WORKFLOW_DB_TEST!=='1',timeout:120000
},async()=>{
 const {pool}=require('../../db');const workflow=require('../../services/OpexService/OpexWorkflow');const read=require('../../services/OpexService/OpexWorkflowRead');
 const client=await pool.connect();const original=pool.query;
 try{
  await client.query('BEGIN');await client.query("SET LOCAL lock_timeout='5s'");
  await client.query(fs.readFileSync(path.resolve(__dirname,'../../docs/migrations/opex-dynamic-workflow.sql'),'utf8').replace(/^BEGIN;|^COMMIT;/gm,''));
  pool.query=client.query.bind(client);
  const org=Number(process.env.OPEX_TEST_ORGANIZATION_ID||20);
  const users=await client.query(`SELECT u.userid,u.usertype,d.departmentname,d.organizationid AS departmentorganizationid,
    EXISTS(SELECT 1 FROM user_org_mapping c WHERE c.userid=u.userid AND c.organizationid=10 AND c.isactive AND NOT c.isdeleted) AS centralfinance
    FROM user_master u JOIN user_org_mapping m ON m.userid=u.userid LEFT JOIN department_master d ON d.departmentid=u.departmentid
    WHERE m.organizationid=$1 AND m.isactive AND NOT m.isdeleted AND u.isactive AND NOT u.isdeleted AND NOT u.islocked`,[org]);
  const creator=users.rows.find(u=>u.departmentname==='Engineering'&&u.usertype==='HOD');assert.ok(creator,'Engineering HOD fixture required');
  let serial=0;
  async function fixture(){
   const result=await client.query(`INSERT INTO opex_master(organizationid,opexnumber,department,item,qty,rate,total,isvoid,isdeleted,createdby,createddate)
    VALUES($1,$2,'Engineering','Workflow rollback test',2,10,20,FALSE,FALSE,$3,CURRENT_TIMESTAMP) RETURNING *`,[org,-Date.now()+serial++,creator.userid]);
   const row=result.rows[0];await client.query(`INSERT INTO opex_approval(opexid,hodstatus,fcstatus,gmstatus,rdfcstatus,ceostatus,finalstatus,isdeleted,createdby,createddate)
    VALUES($1,'Pending','Pending','Pending','Pending','Pending','Pending',FALSE,$2,CURRENT_TIMESTAMP)`,[row.opexid,creator.userid]);return row;
  }
  const row=await fixture();let steps=await workflow.snapshot(client,row.opexid,org);
  assert.equal(steps.length,5);assert.equal(steps[3].approvertype,'USER');
  assert.equal(steps[3].assigneduserid,'9');
  await workflow.authorizeModify(client,row.opexid,creator.userid);
  for(let i=0;i<steps.length;i++){
   steps=await workflow.loadSteps(client,row.opexid);const step=steps[i];
   const actor=users.rows.find(u=>workflow.isAssigned(step,u));assert.ok(actor,'Missing actor for '+step.approvaltype);
   const detail=await read.detail({UserID:actor.userid,OpexID:row.opexid});assert.equal(detail.data.CurrentApprovalStepID,step.stepid);
   assert.equal(detail.data.Approvals[i].CanApprove,true);
   const future=steps[i+1];if(future){const other=users.rows.find(u=>workflow.isAssigned(future,u));
    if(other&&!workflow.isAssigned(step,other))await assert.rejects(workflow.applyAction(client,row,{UserID:other.userid,Action:'APPROVE',ApprovalStepID:future.stepid,Quantity:2}));}
   const recipients=await workflow.recipientIds(client,row,step);assert.ok(recipients.includes(String(actor.userid)));
   const result=await workflow.applyAction(client,row,{UserID:actor.userid,Action:'APPROVE',ApprovalStepID:step.stepid,Revision:0,Quantity:2});
   assert.equal(result.finalStatus,i===steps.length-1?'Approved':null);
   await assert.rejects(workflow.applyAction(client,row,{UserID:actor.userid,Action:'APPROVE',ApprovalStepID:step.stepid,Revision:0,Quantity:2}));
  }
  assert.equal((await client.query('SELECT count(*) FROM opex_workflow_action a JOIN opex_workflow_step s USING(stepid) WHERE s.opexid=$1',[row.opexid])).rows[0].count,'5');
  assert.equal((await read.detail({UserID:creator.userid,OpexID:row.opexid})).data.CurrentStatus,'Approved');
  await assert.rejects(workflow.authorizeModify(client,row.opexid,creator.userid));
  const outsider=await client.query(`SELECT u.userid FROM user_master u WHERE u.isactive AND NOT u.isdeleted AND NOT u.islocked
    AND NOT (u.logintype='SuperAdmin' AND u.allorganizationaccess) AND NOT EXISTS(SELECT 1 FROM user_org_mapping m WHERE m.userid=u.userid AND m.organizationid=$1 AND m.isactive AND NOT m.isdeleted) LIMIT 1`,[org]);
  if(outsider.rows.length)await assert.rejects(read.detail({UserID:outsider.rows[0].userid,OpexID:row.opexid}),/not found|accessible/);
  for(const action of ['REJECT','RETURN','HOLD']){
   const r=await fixture();const ss=await workflow.snapshot(client,r.opexid,org);
   await workflow.applyAction(client,r,{UserID:creator.userid,Action:action,ApprovalStepID:ss[0].stepid,Remarks:'Reviewed',Quantity:1});
   const d=await read.detail({UserID:creator.userid,OpexID:r.opexid});assert.equal(d.data.CanApprove,false);
   assert.equal(d.data.CurrentStatus,{REJECT:'Rejected',RETURN:'Returned',HOLD:'Hold'}[action]);
  }
  const optional=await fixture();const opt=await workflow.snapshot(client,optional.opexid,org);
  await client.query('UPDATE opex_workflow_step SET ismandatory=FALSE WHERE opexid=$1 AND level<>1',[optional.opexid]);
  const final=await workflow.applyAction(client,optional,{UserID:creator.userid,Action:'APPROVE',ApprovalStepID:opt[0].stepid,Quantity:1});assert.equal(final.finalStatus,'Approved');
  const od=await read.detail({UserID:creator.userid,OpexID:optional.opexid});assert.ok(od.data.Approvals.slice(1).every(s=>s.Status==='Skipped'&&!s.CanApprove));
  const legacy=await fixture();const ld=await read.detail({UserID:creator.userid,OpexID:legacy.opexid});assert.equal(ld.data.WorkflowSource,'LEGACY');assert.equal(ld.data.Approvals[0].ApprovalStepID,'legacy:HOD');
  assert.equal(await workflow.applyAction(client,legacy,{UserID:creator.userid,Action:'APPROVE',Quantity:1}),null);
  for(const Status of ['Pending','Approved','Rejected','Returned','Hold']){
   const list=await read.list({UserID:creator.userid,OrganizationID:org,Status});assert.deepEqual(list.ApprovalColumns.map(c=>c.Label),['HOD','FC','GM','RD-FC','CEO']);
  }
  // Run public services in a savepoint. COMMIT only releases that savepoint;
  // notifications are stubbed, and the outer test transaction always rolls back.
  const vm=require('node:vm');const {createRequire}=require('node:module');
  const servicePath=path.resolve(__dirname,'../../services/OpexService/OpexService.js');
  const serviceRequire=createRequire(servicePath);const module={exports:{}};const events=[];
  const adapter={release(){},query:async(sql,values)=>{
    if(sql==='BEGIN')return client.query('SAVEPOINT service_test');
    if(sql==='COMMIT'){events.push('COMMIT');return client.query('RELEASE SAVEPOINT service_test');}
    if(sql==='ROLLBACK')return client.query('ROLLBACK TO SAVEPOINT service_test');
    return client.query(sql,values);
  }};
  vm.runInNewContext(fs.readFileSync(servicePath,'utf8'),{module,exports:module.exports,process,Buffer,
    console:{log(){},error(){}},require:name=>{
      if(name==='../../db')return {pool:{connect:async()=>adapter,query:client.query.bind(client)}};
      if(name==='../../producer/producer')return {sendMessage:async(...args)=>{events.push({notification:args[2]});throw new Error('Test queue failure');}};
      if(name==='../../utils/emailService')return {sendEmail:async()=>{throw new Error('Unexpected email');}};
      return serviceRequire(name);
    }});
  const service=module.exports;
  const created=await service.createOpex({OrganizationID:org,CreatedBy:creator.userid,Department:'Engineering',Item:'OPEX service test',Qty:1,Rate:10,Total:10});
  assert.equal(created.success,true,created.message);
  await new Promise(resolve=>setTimeout(resolve,700));
  assert.ok(events.some(e=>e.notification));assert.equal(events[0],'COMMIT');
  const createdRow=(await client.query("SELECT * FROM opex_master WHERE item='OPEX service test' AND organizationid=$1 ORDER BY opexid DESC LIMIT 1",[org])).rows[0];
  assert.equal((await read.detail({UserID:creator.userid,OpexID:createdRow.opexid})).data.WorkflowSource,'BUILDER');
  const financeLegacy=await fixture();await client.query("UPDATE opex_master SET department='Finance' WHERE opexid=$1",[financeLegacy.opexid]);
  const fc=users.rows.find(u=>u.departmentname==='Finance'&&!u.centralfinance);assert.ok(fc);
  const approvedLegacy=await service.processOpexApproval({OpexID:financeLegacy.opexid,UserID:fc.userid,UserType:'HOD',DepartmentName:'Finance',Action:'APPROVE',Quantity:1});
  assert.equal(approvedLegacy.success,true,approvedLegacy.message);
  await new Promise(resolve=>setTimeout(resolve,700));
  const legacyApproval=(await client.query('SELECT hodstatus,fcstatus FROM opex_approval WHERE opexid=$1',[financeLegacy.opexid])).rows[0];
  assert.equal(legacyApproval.hodstatus,'Approved');assert.equal(legacyApproval.fcstatus,'Approved');
  await client.query(`UPDATE approval_master_details d SET ismandatory=FALSE FROM approval_master am
    WHERE am.approvalmasterid=d.approvalmasterid AND am.organizationid=$1 AND UPPER(am.modulename)='OPEX'
      AND am.isactive AND NOT am.isdelete AND NOT d.isdelete`,[org]);
  const automatic=await service.createOpex({OrganizationID:org,CreatedBy:creator.userid,Department:'Engineering',Item:'OPEX automatic test',Qty:1,Rate:10,Total:10});
  assert.equal(automatic.success,true,automatic.message);
  await new Promise(resolve=>setTimeout(resolve,700));
  const autoRow=(await client.query("SELECT m.opexid,a.finalstatus FROM opex_master m JOIN opex_approval a USING(opexid) WHERE m.item='OPEX automatic test' ORDER BY m.opexid DESC LIMIT 1")).rows[0];
  assert.equal(autoRow.finalstatus,'Approved');
  const autoDetail=await read.detail({UserID:creator.userid,OpexID:autoRow.opexid});
  assert.equal(autoDetail.data.CanApprove,false);assert.equal(autoDetail.data.CanAction,false);
  assert.ok(autoDetail.data.Approvals.every(s=>s.Status==='Skipped'));
  const report=await read.report({UserID:creator.userid,OrganizationID:org},'department');assert.ok(report.some(r=>r.department==='Engineering'));
 }finally{pool.query=original;await client.query('ROLLBACK');client.release();await pool.end();}
});
