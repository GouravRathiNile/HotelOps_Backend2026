const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {createRequire}=require('node:module');
const servicePath=path.resolve(__dirname,'../../services/OpexService/OpexService.js');
const requireService=createRequire(servicePath);
function loadService(overrides){const module={exports:{}};vm.runInNewContext(fs.readFileSync(servicePath,'utf8'),{
 module,exports:module.exports,require:name=>name === "./OpexWorkflow" && name in overrides ? {...requireService(name),...overrides[name]} : name in overrides?overrides[name]:requireService(name),
 console:{log(){},error(){}},process,Buffer,setTimeout,clearTimeout
 });return module.exports;}
module.exports={loadService};

test('Summary, department and organization reports delegate to the authorized shared read model',async()=>{
 const calls=[];const service=loadService({'./OpexWorkflowRead':{report:async(data,group)=>{
  calls.push({data,group});return [{count:5,totalamount:100,pendingcount:1,approvedcount:1,rejectedcount:1,returnedcount:1,holdcount:1,department:'Engineering',organizationid:20,shortname:'TEST'}];
 }}});
 const context={UserID:7,Filters:{OrganizationID:20,Department:'Engineering',FromDate:'2026-09-01',ToDate:'2026-09-30'}};
 const summary=await service.getOpexSummaryReport(context);assert.equal(summary.data.TotalOpex,5);assert.equal(summary.data.HoldCount,1);
 const dept=await service.getOpexDepartmentReport(context);assert.equal(dept.data[0].Department,'Engineering');
 const org=await service.getOpexOrganizationReport(context);assert.equal(org.data[0].OrganizationID,20);
 assert.ok(calls.every(c=>c.data===context));assert.equal(calls[1].group,'department');assert.equal(calls[2].group,'organization');
});

test('List PDF includes configured columns absent from historical records',async()=>{
 const captures=[];const service=loadService({
 './OpexWorkflowRead':{list:async()=>({success:true,TotalPages:1,data:[{OpexID:1,Item:'Test',Approvals:[{ColumnKey:'stage:GM:1',Status:'Approved'}]}],ApprovalColumns:[{Key:'stage:HOD:1',Label:'HOD'},{Key:'stage:GM:1',Label:'GM'},{Key:'stage:CEO:1',Label:'CEO'}]})},
 '../../utils/pdfHelper':{generatePdf:async config=>{captures.push(config);return Buffer.from('PDF');},loadLogo:async()=>null}
 });
 const r=await service.generateOpexListPdf({UserID:7,UserType:'GM',OrganizationID:20,OrganizationName:'TEST'});
 assert.equal(r.success,true);assert.equal(captures.length,1);
 assert.equal(Array.from(captures[0].columns.slice(-3),c=>c.header).join(','),'HOD,GM,CEO');
});

for(const commitFails of [false,true])test('Dynamic approval notifications follow commit and failures are isolated: '+commitFails,async()=>{
 const events=[];const row={opexid:100,organizationid:20,createdby:12,department:'Engineering',item:'Test',qty:1};
 const client={release(){},query:async sql=>{events.push(sql);
  if(sql==='COMMIT'&&commitFails)throw new Error('Commit failed');
  if(sql.includes('FROM Opex_Master cm'))return {rows:[row]};return {rows:[]};}};
 const service=loadService({
 '../../db':{pool:{connect:async()=>client,query:async()=>({rows:[{userid:'12',email:'test@example.invalid',organization_short_name:'TEST'}]})}},
 './OpexWorkflow':{getActor:async()=>({userid:7}),recipientIds:async()=>['12'],applyAction:async()=>({change:{action:'REJECT',status:'Rejected',remarks:'No'},step:{approvaltype:'HOD'},next:null,finalStatus:'Rejected'})},
 '../../producer/producer':{sendMessage:async()=>{events.push('NOTIFY');throw new Error('Queue unavailable');}},
 '../../utils/emailService':{sendEmail:async()=>{throw new Error('Email must not run after failed notification');}}
 });
 const response=await service.processOpexApproval({OpexID:100,UserID:7,Action:'REJECT',Remarks:'No'});
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(response.success,!commitFails);
 if(commitFails)assert.ok(!events.includes('NOTIFY'));
 else {assert.ok(events.indexOf('NOTIFY')>events.indexOf('COMMIT'));assert.ok(!events.includes('ROLLBACK'));}
});

test('PDF controllers forward verified identity to all shared reads',()=>{
 const source=fs.readFileSync(path.resolve(__dirname,'../../controllers/OpexController/OpexController.js'),'utf8');
 for(const name of ['getOpexById','getOpexDepartmentReport','getOpexOrganizationReport','generateOpexListPdf']) {
  const start=source.indexOf('await OpexService.'+name+'({');assert.ok(start>=0);
  assert.match(source.slice(start,start+120),/authenticatedUser\(req\)|\.\.\.user/);
 }
});
