const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const source=fs.readFileSync(path.resolve(__dirname,'../../services/OpexService/OpexService.js'),'utf8');
const context={module:{exports:{}}};
vm.runInNewContext(source.slice(source.indexOf('const opexNotificationContent ='),source.indexOf('// OPEX owns recipient/content'))+
 '\nmodule.exports=opexNotificationContent;',context);
const format=context.module.exports;
test('Every OPEX action uses a consistent title and refined message',()=>{
 const values={item:' Pump ',qty:'120.00',department:' Engineering ',organizationShortName:' HJU ',actorName:' Alex '};
 const cases=[
  ['CREATE',false,'A new Opex request has been created and is awaiting your review.'],
  ['APPROVE',false,'The Opex request has been approved by Alex and is awaiting your review.'],
  ['APPROVE',true,'Your Opex request has been fully approved by Alex.'],
  ['AUTO_APPROVED',false,'Your Opex request has been fully approved by Alex.'],
  ['REJECT',false,'The Opex request has been rejected by Alex.'],
  ['RETURN',false,'The Opex request has been returned by Alex for revision.'],
  ['HOLD',false,'The Opex request has been put on hold by Alex.'],
 ];
 for(const [kind,isFinalApproval,message] of cases){
  const result=format({...values,kind,isFinalApproval});
  assert.equal(result.title,'Opex - Pump (120) - Engineering - HJU');assert.equal(result.message,message);
 }
});
test('OPEX formatting handles missing values and preserves fractional quantities',()=>{
 assert.equal(format({kind:'CREATE'}).title,'Opex - - (-) - - - -');
 assert.equal(format({qty:'1.50'}).title,'Opex - - (1.5) - - - -');
 assert.equal(format({qty:0}).title,'Opex - - (0) - - - -');
 assert.equal(format({kind:'REJECT',approverRole:' GM '}).message,'The Opex request has been rejected by GM.');
 assert.equal(format({kind:'AUTO_APPROVED'}).message,'Your Opex request has been fully approved by System.');
});
test('Both snapshot and legacy final approvals pass presentation-only finality',()=>{
 assert.match(source,/isFinalApproval:dynamic.finalStatus === "Approved"/);
 assert.match(source,/kind: "APPROVE", isFinalApproval: true, notificationAction: "APPROVED"/);
 assert.match(source,/kind, isFinalApproval, item: Opex.item/);
});
