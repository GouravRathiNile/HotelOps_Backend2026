const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
test('Regional OPEX snapshot, recipients, read permissions and multilevel approval', {
 skip: process.env.OPEX_REGIONAL_DB_TEST !== '1', timeout: 120000
}, async () => {
 const {pool} = require('../../db');
 const workflow = require('../../services/OpexService/OpexWorkflow');
 const read = require('../../services/OpexService/OpexWorkflowRead');
 const client = await pool.connect(), originalQuery = pool.query;
 try {
  await client.query('BEGIN');
  await client.query("SET LOCAL lock_timeout='5s'");
  await client.query(fs.readFileSync(path.resolve(__dirname,'../../docs/migrations/opex-regional-approvers.sql'),'utf8').replace(/^BEGIN;|^COMMIT;/gm,''));
  const flow = (await client.query(`SELECT am.* FROM approval_master am WHERE upper(trim(modulename))='OPEX' AND isactive AND NOT isdelete
   AND EXISTS(SELECT 1 FROM approval_master_details d WHERE d.approvalmasterid=am.approvalmasterid AND NOT d.isdelete AND d.approvertype='REGIONAL') LIMIT 1`)).rows[0];
  assert.ok(flow);
  const creator = (await client.query(`SELECT u.userid FROM user_master u JOIN user_org_mapping m USING(userid) JOIN department_master d ON d.departmentid=u.departmentid
   WHERE m.organizationid=$1 AND m.isactive AND NOT m.isdeleted AND u.isactive AND NOT u.isdeleted AND NOT u.islocked
   AND upper(trim(u.usertype))='HOD' AND upper(trim(d.departmentname))='ENGINEERING' AND NOT d.isdeleted LIMIT 1`,[flow.organizationid])).rows[0];
  assert.ok(creator);
  // Exercise public creation in a savepoint; external deliveries are stubbed.
  const vm = require('node:vm');
  const file = path.resolve(__dirname,'../../services/OpexService/OpexService.js');
  let delivered;
  const delivery = new Promise(resolve=>{delivered=resolve;});
  const adapter = {release(){},query:(sql,values)=>client.query(sql==='BEGIN'?'SAVEPOINT create_test'
    :sql==='COMMIT'?'RELEASE SAVEPOINT create_test':sql==='ROLLBACK'?'ROLLBACK TO SAVEPOINT create_test':sql,values)};
  const context = {module:{exports:{}},process,Buffer,console:{log(){},error(){}},setTimeout,clearTimeout};
  context.require = name=>name==='../../db'?{pool:{connect:async()=>adapter,query:client.query.bind(client)}}
    :name==='../../producer/producer'?{sendMessage:async(...args)=>{delivered(args[2]);return {success:false};}}
    :name==='../../utils/emailService'?{sendEmail:async()=>assert.fail('Unexpected external email')}
    :require(name.startsWith('.')?path.resolve(path.dirname(file),name):name);
  vm.runInNewContext(fs.readFileSync(file,'utf8'),context);
  const created = await context.module.exports.createOpex({OrganizationID:flow.organizationid,CreatedBy:creator.userid,
    Department:'Engineering',Item:'Regional rollback test',Qty:2,Rate:10,Total:20});
  assert.equal(created.success,true,created.message);
  let timer;
  try {
    const event = await Promise.race([delivery,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Missing create notification')),15000);})]);
    assert.ok(event.data.userIds.includes(String(creator.userid)));
  } finally {clearTimeout(timer);}
  const row = (await client.query("SELECT * FROM opex_master WHERE item='Regional rollback test' AND organizationid=$1 ORDER BY opexid DESC LIMIT 1",[flow.organizationid])).rows[0];
  assert.ok(row);
  const steps = await workflow.loadSteps(client,row.opexid);
  const regional = steps.find(s=>s.approvertype==='REGIONAL');
  assert.ok(regional);
  await client.query('UPDATE user_org_mapping SET isactive=FALSE WHERE userid=$1 AND organizationid=$2',[regional.assigneduserid,row.organizationid]);
  pool.query = client.query.bind(client);
  for (const step of steps.filter(s=>s.ismandatory)) {
   const ids = await workflow.recipientIds(client,row,step);
   assert.ok(ids.length,'Missing eligible '+step.approvaltype);
   const actor = await workflow.getActor(client,row.organizationid,ids[0],row.opexid);
   if (step.approvertype==='REGIONAL') {
    assert.equal(actor.regionaleligible,true);
    assert.equal(actor.organizationaccess,false);
    assert.equal(ids[0],String(regional.assigneduserid));
   }
   assert.equal((await read.detail({UserID:ids[0],OpexID:row.opexid})).data.CanApprove,true);
   await workflow.applyAction(client,row,{UserID:ids[0],Action:'APPROVE',Quantity:2,ApprovalStepID:step.stepid});
  }
  assert.equal((await read.detail({UserID:creator.userid,OpexID:row.opexid})).data.CurrentStatus,'Approved');
  await client.query('UPDATE user_primary_organization SET isactive=FALSE WHERE userid=$1',[regional.assigneduserid]);
  await assert.rejects(workflow.getActor(client,row.organizationid,regional.assigneduserid,row.opexid),/access/);
 } finally {
  pool.query = originalQuery;
  await client.query('ROLLBACK');
  client.release();
  await pool.end();
 }
});
