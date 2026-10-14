const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const AppError=require('../../utils/AppError');
const source=fs.readFileSync(path.resolve(__dirname,'../../controllers/EngineeringController/EngineeringController.js'),'utf8');
const body=source.slice(source.indexOf('exports.processAMCApproval ='),source.indexOf('// ============================================================Create AMC Approval Config'));
const load=()=>{
 const sent=[],context={exports:{},AppError,
  sendQueueResponse:async(req,res,action,data)=>{sent.push({action,data});return data;},
  handleError:error=>({statusCode:error.statusCode,message:error.message})};
 vm.runInNewContext(body,context);return {approve:context.exports.processAMCApproval,sent};
};
test('AMC controller forwards additive step/revision fields without changing the queue command',async()=>{
 const {approve,sent}=load();
 await approve({body:{AMCID:1,Action:'APPROVE',ApprovalStepID:'2',Revision:0},user:{UserType:'HOD',DepartmentName:'Finance'}},{});
 assert.equal(sent[0].action,'PROCESS_ENGINEERING_AMC_APPROVAL');
 assert.equal(sent[0].data.ApprovalStepID,'2');assert.equal(sent[0].data.Revision,0);
});
test('Existing AMC approval payload remains accepted',async()=>{
 const {approve,sent}=load();
 await approve({body:{AMCID:1,Action:'RETURN',Remarks:'Reviewed'},user:{}},{});
 assert.equal(sent.length,1);assert.equal(sent[0].data.ApprovalStepID,undefined);
});
for(const body of [{ApprovalStepID:0},{ApprovalStepID:'legacy:FC'},{ApprovalStepID:1.5},{Revision:-1},{Revision:1.5}]) {
 test('AMC controller rejects invalid workflow identifier '+JSON.stringify(body),async()=>{
  const {approve,sent}=load();const result=await approve({body,user:{}},{});
  assert.equal(result.statusCode,400);assert.equal(sent.length,0);
 });
}
