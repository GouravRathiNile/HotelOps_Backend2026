const test=require('node:test');
const assert=require('node:assert/strict');
const workflow=require('../../services/EngineeringService/EngineeringAMCWorkflow');
const read=require('../../services/EngineeringService/EngineeringAMCWorkflowRead');
const record={amcid:'1',organizationid:'20',departmentid:'2',createdby:'7',finalstatus:'Pending'};
const actor={userid:'6',usertype:'HOD',departmentname:'Finance',departmentorganizationid:'20',organizationaccess:true,iscentralrd:false};
const step={stepid:'1',level:1,approvertype:'ROLE',role:'FC',approvaltype:'FC',ismandatory:true,status:'Pending',revision:0};

test('Legacy RD and builder RD-FC expose the same stage while preserving approval history and assignment',()=>{
 for (const approvaltype of ['RD','RD-FC']) {
  const mapped=read.mapRow({...record,steps:[{...step,role:'RD',approvaltype,status:'Approved',remarks:'Reviewed'}],
   finalstatus:'Approved',iscentralrd:true},'6',row=>({CurrentApprovalRole:row.currentapprovalrole,Documents:[]}));
  assert.equal(mapped.Approvals[0].ApprovalType,'RD-FC');
  assert.equal(mapped.Approvals[0].ApprovalRole,'RD-FC');
  assert.equal(mapped.Approvals[0].ColumnKey,'stage:RD-FC:1');
  assert.equal(mapped.Approvals[0].Status,'Approved');
  assert.equal(mapped.Approvals[0].Remarks,'Reviewed');
  assert.equal(mapped.Approvals[0].Role,'RD');
 }
 const oldFilter=read.buildQuery({UserID:'6',OrganizationID:'20',ApprovalFlow:'RD'},true);
 const newFilter=read.buildQuery({UserID:'6',OrganizationID:'20',ApprovalFlow:'RD-FC'},true);
 assert.deepEqual(oldFilter,newFilter);
 assert.ok(newFilter.values.includes('RD-FC'));
});
test('AMC FC and central RD retain distinct live assignment rules',()=>{
 assert.equal(workflow.isAssigned(step,actor,record),true);
 assert.equal(workflow.isAssigned(step,{...actor,iscentralrd:true},record),false);
 assert.equal(workflow.isAssigned({...step,role:'RD'},{...actor,organizationaccess:false,iscentralrd:true},record),true);
 assert.equal(workflow.isAssigned({...step,role:'RD'},actor,record),false);
});
test('Explicit USER/REGIONAL authority is separate from business stage and account role',()=>{
 const selected={...step,approvertype:'USER',role:null,assigneduserid:'6',approvaltype:'CEO'};
 assert.equal(workflow.isAssigned(selected,actor,record),true);
 assert.equal(workflow.isAssigned(selected,{...actor,userid:'8'},record),false);
 const regional={...selected,approvertype:'REGIONAL'};
 assert.equal(workflow.isAssigned(regional,{...actor,organizationaccess:false,regionaleligible:true},record),true);
 assert.equal(workflow.isAssigned(regional,{...actor,regionaleligible:false},record),false);
 assert.equal(workflow.isAssigned(selected,{...actor,organizationaccess:false},record),false);
});
test('New HOD role matches the linked equipment department',()=>{
 assert.equal(workflow.isAssigned({...step,role:'HOD',approvaltype:'HOD'},{...actor,departmentid:'2'},record),true);
 assert.equal(workflow.isAssigned({...step,role:'HOD',approvaltype:'HOD'},{...actor,departmentid:'3'},record),false);
});
test('Reordered levels, optional steps, future and consumed stages govern permissions',()=>{
 const steps=[{...step,ismandatory:false},{...step,stepid:'2',level:2},
  {...step,stepid:'3',level:3,approvertype:'USER',assigneduserid:'8'}];
 assert.equal(workflow.currentStep(steps).stepid,'2');
 assert.deepEqual(workflow.allowedActions(record,steps,steps[0],actor),[]);
 assert.deepEqual(workflow.allowedActions(record,steps,steps[2],{...actor,userid:'8'}),[]);
 for(const status of ['Rejected','Returned','Approved']) {
  steps[1].status=status;
  assert.deepEqual(workflow.allowedActions(record,steps,steps[1],actor),[]);
 }
 steps[1].status='Pending';steps[1].revision=1;
 assert.deepEqual(workflow.allowedActions(record,steps,steps[1],actor),[]);
});
const clientFor=(steps)=>{
 const calls=[];return {calls,query:async(sql,values)=>{
  calls.push({sql,values});
  if(sql.includes('FROM engineering_amc_workflow_step s'))return {rows:steps};
  if(sql.includes('SELECT * FROM engineering_amc_approval'))return {rows:[{finalstatus:'Pending'}]};
  if(sql.includes('SELECT um.userid,um.usertype,um.departmentid'))return {rows:[actor]};
  if(sql.includes('RETURNING revision'))return {rows:[{revision:1,actiondatetime:'2026-10-13T00:00:00'}]};
  if(sql.includes('SELECT um.userid,um.usertype,um.departmentid,dm.departmentname'))return {rows:[actor]};
  return {rows:[],rowCount:1};
 }};
};
for(const Action of ['REJECT','RETURN'])test(Action+' consumes the current step, records history and targets creator',async()=>{
 const client=clientFor([{...step}]);
 const result=await workflow.applyAction(client,record,{UserID:'6',Action,Remarks:'Reviewed',ApprovalStepID:'1',Revision:0});
 assert.deepEqual(result.recipients,['7']);
 assert.ok(client.calls.some(c=>c.sql.includes('INSERT INTO engineering_amc_workflow_action')));
 assert.ok(!client.calls.some(c=>c.sql.includes('UPDATE Engineering_Equipment_Entry_Master')));
 assert.ok(!client.calls.some(c=>c.sql==='COMMIT'));
});
test('Final configured approval synchronizes equipment and returns final notification kind',async()=>{
 const client=clientFor([{...step}]);
 const result=await workflow.applyAction(client,record,{UserID:'6',Action:'APPROVE',ApprovalStepID:'1',Revision:0});
 assert.equal(result.kind,'FINAL_APPROVE');assert.equal(result.finalStatus,'Approved');
 assert.deepEqual(result.recipients,['7']);
 assert.ok(client.calls.some(c=>c.sql.includes('UPDATE Engineering_Equipment_Entry_Master')));
});
for(const invalid of [{Action:'HOLD'},{Action:'RETURN',Remarks:''},{Action:'APPROVE',Revision:5},{Action:'APPROVE',ApprovalStepID:'2'}]) {
 test('Invalid/stale AMC action cannot persist '+JSON.stringify(invalid),async()=>{
  const client=clientFor([{...step}]);
  await assert.rejects(workflow.applyAction(client,record,{UserID:'6',...invalid}));
  assert.ok(!client.calls.some(c=>/^\s*(UPDATE|INSERT)/.test(c.sql)));
 });
}
test('Repeated assignment requires explicit step ID to prevent accidental consecutive approval',async()=>{
 const client=clientFor([{...step},{...step,stepid:'2',level:2}]);
 await assert.rejects(workflow.applyAction(client,record,{UserID:'6',Action:'APPROVE'}),/ApprovalStepID/);
});
test('Snapshot rejects unsupported types, missing stages, invalid users and duplicate levels',async()=>{
 for(const details of [[{...step,approvertype:'OTHER'}],[{...step,approvaltype:''}],
  [{...step,approvertype:'REGIONAL',role:'Selected Name'}],[{...step},{...step}]]) {
  const writes=[];const client={query:async(sql)=>{
   if(sql.includes('SELECT approvalmasterid'))return {rows:[{approvalmasterid:'1'}]};
   if(sql.includes('SELECT * FROM approval_master_details'))return {rows:details};
   if(sql.includes('SELECT um.userid'))return {rows:[actor]};
   if(/^\s*(UPDATE|INSERT)/.test(sql))writes.push(sql);
   return {rows:[]};
  }};
  await assert.rejects(workflow.snapshot(client,record));assert.equal(writes.length,0);
 }
});
test('Read query is parameterized and supports dynamic stage labels and Regional scope',()=>{
 const q=read.buildQuery({UserID:'6',OrganizationID:'20',ApprovalFlow:'CUSTOM STAGE',Status:'Pending'},true);
 assert.ok(q.values.includes('CUSTOM STAGE'));assert.ok(!q.where.includes('CUSTOM STAGE'));
 assert.match(q.where,/currentstep/);assert.match(q.cte,/user_primary_organization/);
 assert.throws(()=>read.buildQuery({}),/UserID/);
 assert.throws(()=>read.buildQuery({UserID:'6',Status:'Hold'}),/status/);
});

test('Builder ROLE HOD at FC stage resolves property Finance HOD, not equipment department HOD',()=>{
 const fc={...step,role:'HOD',approvaltype:'FC'};
 assert.equal(workflow.isAssigned(fc,actor,record),true);
 assert.equal(workflow.isAssigned(fc,{...actor,departmentname:'Engineering',departmentid:record.departmentid},record),false);
 assert.equal(workflow.isAssigned(fc,{...actor,iscentralrd:true},record),false);
});

test('AMC and AMC Renewal aliases share exactly-one-flow validation',async()=>{
 for(const rows of [[],[{approvalmasterid:1},{approvalmasterid:2}]]) {
  const calls=[];const client={query:async sql=>{calls.push(sql);return {rows};}};
  await assert.rejects(workflow.snapshot(client,record),/Exactly one active AMC/);
  assert.match(calls[0],/IN \('AMC','AMC RENEWAL'\)/);
  assert.equal(calls.length,1);
 }
});

test('Only creator can edit/delete until first approval; role and admin do not grant edit rights',()=>{
 const pending={...record,createdby:'7',hasapproval:false};
 assert.equal(workflow.canModify(pending,{userid:'7'}),true);
 assert.equal(workflow.canModify(pending,{userid:'6',usertype:'GM'}),false);
 assert.equal(workflow.canModify(pending,{userid:'1',usertype:'SuperAdmin'}),false);
 assert.equal(workflow.canModify({...pending,hasapproval:true},{userid:'7'}),false);
 assert.equal(workflow.canModify({...pending,finalstatus:'Approved'},{userid:'7'}),false);
 assert.equal(workflow.canModify({...pending,isdeleted:true},{userid:'7'}),false);
 assert.equal(workflow.canModify({...pending,finalstatus:'Returned'},{userid:'7'}),true);
});
test('Selected USER acts at GM stage; account GM has no authority',()=>{
 const assigned={...step,approvertype:'USER',role:null,assigneduserid:'13',approvaltype:'GM'};
 const user={...actor,userid:'13',usertype:'HOD'};
 const gm={...actor,userid:'4',usertype:'GM'};
 assert.equal(workflow.allowedActions(record,[assigned],assigned,user).includes('APPROVE'),true);
 assert.deepEqual(workflow.allowedActions(record,[assigned],assigned,gm),[]);
 const mapped=read.mapRow({...record,steps:[assigned],actorrole:'HOD',organizationaccess:true,
   hasapproval:false},'13',row=>({AMCID:Number(row.amcid),Documents:[]}));
 assert.equal(mapped.CanApprove,true);assert.equal(mapped.CanEdit,false);
 assert.deepEqual(mapped.AllowedActions,['APPROVE','REJECT','RETURN']);
 const other=read.mapRow({...record,steps:[assigned],actorrole:'GM',organizationaccess:true,
   hasapproval:false},'4',row=>({Documents:[]}));
 assert.equal(other.CanApprove,false);assert.deepEqual(other.AllowedActions,[]);
});
