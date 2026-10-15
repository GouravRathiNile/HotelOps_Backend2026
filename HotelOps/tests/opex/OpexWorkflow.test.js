const test = require('node:test');
const assert = require('node:assert/strict');
const workflow = require('../../services/OpexService/OpexWorkflow');
const read = require('../../services/OpexService/OpexWorkflowRead');
const {pool} = require('../../db');
const stages = () => ['HOD','FC','GM','RD-FC','CEO'].map((role,i)=>({stepid:String(i+1),level:i+1,
 approvertype:role==='RD-FC'?'USER':'ROLE',role:['HOD','FC'].includes(role)?'HOD':role,
 assigneduserid:role==='RD-FC'?'9':null,approvaltype:role,ismandatory:true,status:'Pending',revision:0,
 organizationid:20,requestdepartment:'Engineering'}));
const actors=[{userid:7,usertype:'HOD',departmentname:'Engineering',departmentorganizationid:20},
 {userid:6,usertype:'HOD',departmentname:'Finance',departmentorganizationid:20,centralfinance:false},
 {userid:4,usertype:'GM'}, {userid:9,usertype:'HOD',departmentname:'Finance',departmentorganizationid:20,centralfinance:true},
 {userid:1,usertype:'CEO'}];
const record={opexid:100,organizationid:20,department:'Engineering',createdby:12,hasaction:false};

for (const action of ['APPROVE','REJECT','RETURN','HOLD']) test(action+' handles consecutive Finance HOD/FC assignments safely',async()=>{
 const steps=stages().map(step=>({...step,requestdepartment:'Finance'}));
 const calls=[];
 const client={query:async(sql,params)=>{
  calls.push({sql,params});
  if(sql.includes('UPDATE opex_workflow_step'))return {rows:[{revision:1,actiondatetime:new Date()}]};
  if(sql.includes('SELECT'))return {rows:steps};
  return {rows:[]};
 }};
 const result=await workflow.applyAction(client,{...record,department:'Finance'},
  {Action:action,UserID:6,ApprovalStepID:1,Revision:0,Quantity:3,Remarks:'Reviewed'},actors[1]);
 const updates=calls.filter(c=>c.sql.includes('UPDATE opex_workflow_step'));
 assert.deepEqual(updates.map(c=>c.params[4]),action==='APPROVE'?['1','2']:['1']);
 assert.equal(calls.filter(c=>c.sql.includes('INSERT INTO opex_workflow_action')).length,updates.length);
 if(action==='APPROVE'){
  assert.equal(result.next.stepid,'3');assert.deepEqual(result.roles,['GM']);
  assert.equal(result.finalStatus,null);assert.deepEqual(result.directUserIds,[]);
 }else assert.equal(steps[1].status,'Pending');
});

test('Consecutive direct-user approvals can finalize but never cross another assignee',async()=>{
 for(const sameUser of [true,false]){
  const steps=stages().slice(0,2).map((s,i)=>({...s,approvertype:'USER',assigneduserid:i===1&&!sameUser?'4':'6'}));
  const client={query:async(sql)=>sql.includes('UPDATE opex_workflow_step')?
   {rows:[{revision:1,actiondatetime:new Date()}]}:sql.includes('SELECT')?{rows:steps}:{rows:[]}};
  const result=await workflow.applyAction(client,record,{Action:'APPROVE',ApprovalStepID:1,UserID:6},actors[1]);
  assert.equal(result.finalStatus,sameUser?'Approved':null);
  assert.deepEqual(result.directUserIds,sameUser?[12]:['4']);
 }
});
test('Configured HOD and FC both use role HOD but match different departments',()=>{
 const steps=stages();for(let i=0;i<actors.length;i++)for(let j=0;j<steps.length;j++)assert.equal(workflow.isAssigned(steps[j],actors[i]),i===j);
 assert.equal(workflow.isAssigned(steps[0],{...actors[0],departmentorganizationid:30}),false);
 assert.equal(workflow.isAssigned(steps[3],{...actors[3],usertype:'Associate'}),true);
});
test('Only the current configured assignee acts; each approval enables the next',()=>{
 const steps=stages();for(let i=0;i<steps.length;i++){
  actors.forEach((actor,j)=>assert.equal(workflow.permissions(record,steps,actor).CanApprove,i===j));
  steps[i].status='Approved';
 }assert.equal(workflow.currentStep(steps),null);
});
for(const status of ['Rejected','Returned','Hold','Approved'])test(status+' consumes its step',()=>{
 const steps=stages();steps[0].status=status;
 for(const action of ['APPROVE','REJECT','RETURN','HOLD'])assert.throws(()=>workflow.authorizeApproval(record,steps,actors[0],action));
 assert.equal(workflow.permissions(record,steps,actors[1]).CanApprove,status==='Approved');
});
test('Optional first, middle, trailing and all-optional combinations skip correctly',()=>{
 for(let mask=0;mask<32;mask++){
  const steps=stages().map((s,i)=>({...s,ismandatory:Boolean(mask&(1<<i))}));
  for(const step of steps){if(!step.ismandatory){assert.equal(workflow.canAct(steps,step,'APPROVE'),false);continue;}
   assert.equal(workflow.currentStep(steps),step);step.status='Approved';}
  assert.equal(workflow.currentStep(steps),null);
 }
});
test('Creator or same department HOD may modify only before any action',()=>{
 assert.equal(workflow.canModify(record,{userid:12}),true);
 assert.equal(workflow.canModify(record,actors[0]),true);
 for(const actor of actors.slice(1))assert.equal(workflow.canModify(record,actor),false);
 for(const override of [{hasaction:true},{isvoid:true},{isdeleted:true}])assert.equal(workflow.canModify({...record,...override},actors[0]),false);
});
test('Read mapping keeps real step IDs and stable display keys, including repeated stages',()=>{
 const steps=stages();steps.push({...steps[0],stepid:'6',level:6});
 const row=read.mapRow({...record,steps,dynamic:true,actorrole:'HOD',actordepartmentname:'Engineering',actordepartmentorganizationid:20},7);
 assert.equal(row.CanApprove,true);assert.equal(row.Approvals[0].CanApprove,true);
 assert.ok(row.Approvals.slice(1).every(s=>!s.CanApprove));
 assert.equal(row.Approvals[5].ColumnKey,'stage:HOD:2');assert.equal(row.Approvals[5].ApprovalStepID,'6');
});
test('All queries enforce persisted membership, department scope and date filters',()=>{
 assert.throws(()=>read.buildQuery({OrganizationID:20}),/Authenticated/);
 const q=read.buildQuery({UserID:7,OrganizationID:20,FromDate:'2026-09-01',ToDate:'2026-09-30',Status:'Pending'});
 assert.match(q.cte,/uom.organizationid = cm.organizationid/);assert.match(q.where,/actordepartmentname/);
 assert.ok(q.values.includes(20));assert.match(q.where,/INTERVAL '1 day'/);
});
test('List headers come from active Builder config independently of status or empty pages',async()=>{
 const original=pool.query;const calls=[];
 pool.query=async(sql,values)=>{calls.push({sql,values});
  if(sql.includes('configured_columns'))return {rows:stages().map(s=>({columnkey:`stage:${s.approvaltype}:1`,label:s.approvaltype,level:s.level}))};
  if(sql.includes('COUNT(*) AS count'))return {rows:[{count:0}]};return {rows:[]};};
 try{for(const Status of ['Pending','Approved','Rejected','Returned','Hold']){
  const result=await read.list({UserID:7,OrganizationID:20,Status});
  assert.deepEqual(result.ApprovalColumns.map(c=>c.Label),['HOD','FC','GM','RD-FC','CEO']);assert.deepEqual(result.data,[]);
 }assert.ok(calls.filter(c=>c.sql.includes('configured_columns')).every(c=>c.values[1]===20));}finally{pool.query=original;}
});
for(const action of ['REJECT','RETURN','HOLD'])test(action+' requires meaningful remarks',()=>assert.throws(()=>workflow.validateAction({Action:action}),/Remarks/));

test('Regional assignment requires selected user and active company primary membership',()=>{
 const step={...stages()[3],approvertype:'REGIONAL'};
 const actor={...actors[3],regionaleligible:true,organizationaccess:false};
 assert.equal(workflow.isAssigned(step,actor),true);
 assert.equal(workflow.isAssigned(step,{...actor,userid:8}),false);
 assert.equal(workflow.isAssigned(step,{...actor,regionaleligible:false}),false);
 assert.equal(workflow.isAssigned({...step,approvertype:'USER'},actor),false);
});
test('Snapshot supports Regional while retaining business stage and selected user',async()=>{
 const calls=[];const client={query:async(sql,values)=>{
  calls.push({sql,values});
  if(sql.includes('SELECT approvalmasterid'))return {rows:[{approvalmasterid:1,flowname:'Opex'}]};
  if(sql.includes('SELECT approvalid'))return {rows:[{approvalid:2,level:1,approvertype:'REGIONAL',role:'9',approvaltype:'RD-FC',ismandatory:true}]};
  if(sql.includes('SELECT um.userid,um.usertype'))return {rows:[{userid:9,regionaleligible:true,organizationaccess:false}]};
  return {rows:[]};
 }};
 await workflow.snapshot(client,100,20);
 assert.deepEqual(calls.find(c=>c.sql.includes('INSERT INTO opex_workflow_step')).values,[100,2,1,'REGIONAL',null,'RD-FC',true,'9']);
});
