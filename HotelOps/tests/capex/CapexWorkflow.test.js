const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const workflow = require("../../services/CapexService/CapexWorkflow");
const read = require("../../services/CapexService/CapexWorkflowRead");
const { pool } = require("../../db");

const stages = () => [
    { stepid: "1", level: 1, sourceid: "11", approvertype: "ROLE", role: "GM", approvaltype: "GM", ismandatory: true, status: "Pending", revision: 0 },
    { stepid: "2", level: 3, sourceid: "12", approvertype: "ROLE", role: "CEO", approvaltype: "CEO", ismandatory: true, status: "Pending", revision: 0 }
];
const gm = { userid: "9", usertype: "GM" };
const ceo = { userid: "10", usertype: "CEO" };

test("Configured levels determine order without adding OWNER", () => {
    const steps = stages();
    assert.equal(workflow.currentStep(steps).approvaltype, "GM");
    steps[0].status = "Approved";
    assert.equal(workflow.currentStep(steps).approvaltype, "CEO");
    steps[1].status = "Approved";
    assert.equal(workflow.currentStep(steps), null);
});
test("USER assignment is independent of business stage and actor role", () => {
    const step = { ...stages()[0], approvertype: "USER", assigneduserid: "42" };
    assert.ok(workflow.isAssigned(step, { userid: 42, usertype: "HOD" }));
    assert.ok(!workflow.isAssigned(step, gm));
    assert.equal(workflow.chooseStep([step], { userid: 42 }, "APPROVE").approvaltype, "GM");
});
for (const status of ["Pending","Rejected","Returned","Hold"]) {
    for (const action of ["APPROVE","REJECT","RETURN","HOLD"]) {
        test(status + " current step permits " + action, () => {
            const steps = stages(); steps[0].status = status;
            assert.equal(workflow.chooseStep(steps, gm, action).stepid, "1");
            assert.throws(() => workflow.chooseStep(steps, ceo, action), /not authorized/);
        });
    }
}
test("Previous approved step can reject or return only while next step is pending", () => {
    const steps = stages(); steps[0].status = "Approved";
    for (const action of ["REJECT","RETURN"]) assert.ok(workflow.canAct(steps, steps[0], action));
    for (const action of ["APPROVE","HOLD"]) assert.ok(!workflow.canAct(steps, steps[0], action));
    steps[1].status = "Hold";
    assert.ok(!workflow.canAct(steps, steps[0], "REJECT"));
    steps[1].status = "Approved";
    assert.ok(!workflow.canAct(steps, steps[0], "REJECT"));
});
test("Repeated assignments require explicit stage identity", () => {
    const steps = stages(); steps[1].role = "GM";
    assert.throws(() => workflow.chooseStep(steps, gm, "APPROVE"), /ApprovalStepID/);
    assert.equal(workflow.chooseStep(steps, gm, "APPROVE", "1").stepid, "1");
    assert.throws(() => workflow.chooseStep(steps, gm, "APPROVE", "2"), /not authorized/);
});
test("Remarks and quantities remain validated", () => {
    for (const Action of ["REJECT","RETURN","HOLD"]) assert.throws(() => workflow.validateAction({ Action }), /Remarks/);
    for (const Quantity of [0,-1,"bad"]) assert.throws(() => workflow.validateAction({ Action:"APPROVE",Quantity }), /Quantity/);
    assert.equal(workflow.validateAction({ Action:"approve",Quantity:2 }).status,"Approved");
});

function actionClient(steps, actor = gm) {
    const calls = [];
    return { calls, query: async (sql, values) => {
        calls.push({ sql, values });
        if (sql.includes("SELECT um.userid")) return { rows: actor ? [actor] : [] };
        if (sql.includes("SELECT * FROM capex_workflow_step")) return { rows: steps };
        if (sql.includes("RETURNING revision")) return { rows: [{ revision: 1 }] };
        return { rows: [] };
    } };
}
const capex = { capexid: "7", organizationid: "20", createdby: "3", isvoid: false };
for (const Action of ["APPROVE","REJECT","RETURN","HOLD"]) {
    test("Persist " + Action + " with history and recipient assignment", async () => {
        const client = actionClient(stages());
        const result = await workflow.applyAction(client, capex, {
            UserID:9, Action, ApprovalStepID:"1", Remarks:"Reviewed", Quantity:2, Revision:0
        });
        assert.equal(result.step.status, workflow.validateAction({Action,Remarks:"Reviewed"}).status);
        assert.ok(client.calls.some(call => call.sql.includes("INSERT INTO capex_workflow_action")));
        assert.deepEqual(result.roles, [Action === "APPROVE" ? "CEO" : "GM"]);
        assert.deepEqual(result.directUserIds, Action === "APPROVE" ? [] : ["3"]);
        assert.ok(!client.calls.some(call => call.sql === "COMMIT")); // Caller owns transaction.
    });
}
test("Final configured approval targets creator and marks final approved", async () => {
    const steps = stages(); steps[0].status = "Approved";
    const result = await workflow.applyAction(actionClient(steps,ceo),capex,{UserID:10,Action:"APPROVE"});
    assert.equal(result.finalStatus,"Approved");
    assert.deepEqual(result.roles,[]);
    assert.deepEqual(result.directUserIds,["3"]);
});
test("Actor outside organization cannot act, even with matching JWT role", async () => {
    const client = actionClient(stages(), null);
    await assert.rejects(workflow.applyAction(client,capex,{UserID:9,UserType:"GM",Action:"APPROVE"}), /access/);
    assert.ok(!client.calls.some(call => /^\s*UPDATE/.test(call.sql)));
    assert.match(client.calls[0].sql,/uom.organizationid = om.organizationid/);
});
test("Legacy requests return to legacy processor without rewriting their state", async () => {
    const client = actionClient([]);
    assert.equal(await workflow.applyAction(client,capex,{UserID:9,Action:"APPROVE"}),null);
    assert.ok(!client.calls.some(call => /^\s*(UPDATE|INSERT)/.test(call.sql)));
});
test("Stale revisions cannot mutate steps", async () => {
    const client = actionClient(stages());
    await assert.rejects(workflow.applyAction(client,capex,{UserID:9,Action:"APPROVE",Revision:5}), /refresh/);
    assert.ok(!client.calls.some(call => /^\s*UPDATE/.test(call.sql)));
});

test("Read model returns distinct column keys and action permissions", () => {
    const steps = stages(); steps[0].status="Hold"; steps[0].approvedquantity="2";steps[0].remarks="Review";
    const result=read.mapRow({...capex,dynamic:true,actorrole:"GM",steps,workflowstatus:"Hold"},9);
    assert.equal(result.CurrentApprovalStage,"GM");
    assert.equal(result.CanApprove,true);
    assert.deepEqual(result.Approvals[0].AllowedActions,["APPROVE","REJECT","RETURN","HOLD"]);
    assert.equal(result.Approvals[0].ApprovedQuantity,2);
    assert.equal(result.Approvals[0].Remarks,"Review");
    assert.notEqual(result.Approvals[0].ColumnKey,result.Approvals[1].ColumnKey);
});
test("All read/filter SQL is parameterized and scoped by persisted membership", () => {
    const query=read.buildQuery({UserID:9,OrganizationID:20,ApprovalFlow:"HOD",Status:"Pending"});
    assert.match(query.cte,/uom.userid = a.userid AND uom.organizationid = cm.organizationid/);
    assert.match(query.cte,/NOT EXISTS \(SELECT 1 FROM capex_workflow WHERE capexid = cm.capexid\)/);
    assert.match(query.where,/r.organizationid = \$2/);
    assert.match(query.where,/s->>'approvaltype'/);
    assert.deepEqual(query.values,[9,20,"HOD","PENDING"]);
    assert.throws(()=>read.buildQuery({OrganizationID:20}),/UserID/);
});

function loadService(client, workflowMock, dispatch, mocks = {}) {
    const file=path.resolve(__dirname,"../../services/CapexService/CapexService.js");
    const context={module:{exports:{}},console:{error() {},log() {}},process,Buffer};
    context.require=name=>{
        if (Object.hasOwn(mocks, name)) return mocks[name];
        if(name==="../../db") return {pool:{connect:async()=>client,query:async()=>({rows:[{userid:"10",organization_short_name:"TEST"}]})}};
        if(name==="./CapexWorkflow") return workflowMock;
        if(name==="../../producer/producer") return {sendMessage:dispatch};
        return require(name.startsWith(".")?path.resolve(path.dirname(file),name):name);
    };
    vm.runInNewContext(fs.readFileSync(file,"utf8"),context);
    return context.module.exports;
}
test("Post-commit notifications preserve email payload and queue failure cannot undo success", async () => {
    const calls=[];
    const client={query:async sql=>{
        calls.push(sql);
        if(sql.includes("FROM Capex_Master cm")) return {rows:[{...capex,item:"Pump",qty:2,department:"Engineering"}]};
        return {rows:[]};
    },release(){}};
    let sent;
    const service=loadService(client,{
        normalized:workflow.normalized,getActor:async()=>gm,
        applyAction:async()=>({change:{action:"APPROVE",status:"Approved",quantity:2,remarks:"OK"},
            step:{approvaltype:"GM"},next:{role:"CEO"},roles:["CEO"],directUserIds:[]})
    },async(...args)=>{assert.ok(calls.includes("COMMIT"));sent=args[2];throw new Error("queue unavailable");});
    const result=await service.processCapexApproval({CapexID:7,UserID:9,Action:"APPROVE"});
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(result.success,true);
    assert.equal(sent.data.emailData.actionQuantity,2);
    assert.ok(!calls.includes("ROLLBACK"));
});
test("Commit failure never dispatches notifications", async () => {
    let sent=false;
    const client={query:async sql=>{
        if(sql==="COMMIT") throw new Error("commit failed");
        if(sql.includes("FROM Capex_Master cm"))return {rows:[capex]};
        return {rows:[]};
    },release(){}};
    const service=loadService(client,{
        normalized:workflow.normalized,getActor:async()=>gm,
        applyAction:async()=>({change:{action:"APPROVE"},step:{},next:{}})
    },async()=>{sent=true});
    const result=await service.processCapexApproval({CapexID:7,UserID:9,Action:"APPROVE"});
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(result.success,false);assert.equal(sent,false);
});

test("List, detail and grouped reports use shared stage state", async () => {
    const original=pool.query;const calls=[];
    pool.query=async(sql,values)=>{
        calls.push({sql,values});
        if(sql.includes("SELECT COUNT(*) AS count")) return {rows:[{count:1}]};
        if(sql.includes("SELECT DISTINCT r.dynamic"))return {rows:[{dynamic:true,sourceid:"11",label:"GM",level:1}]};
        if(sql.includes("SELECT r.*"))return {rows:[{...capex,steps:stages(),dynamic:true,actorrole:"GM",workflowstatus:"Pending"}]};
        return {rows:[]};
    };
    try{
        const result=await read.list({UserID:9,OrganizationID:20});
        assert.equal(result.TotalCount,1);assert.equal(result.ApprovalColumns[0].Key,"flow:11");
        assert.equal((await read.detail({UserID:9,CapexID:7})).data.CurrentApprovalStage,"GM");
        await read.report({UserID:9,Filters:{OrganizationID:20}},"department");
        assert.ok(calls.filter(c=>c.sql.includes("FROM records")).every(c=>c.sql.includes("capex_workflow_step")));
    }finally{pool.query=original;}
});

test("Snapshot loads active organization CAPEX configuration and locks before copying levels", async () => {
    const calls=[];
    const client={query:async(sql,values)=>{
        calls.push({sql,values});
        if(sql.includes("SELECT approvalmasterid"))return {rows:[{approvalmasterid:"6",flowname:"Capex"}]};
        if(sql.includes("SELECT approvalid"))return {rows:stages().map(s=>({...s,approvalid:s.sourceid}))};
        if(sql.includes("SELECT 1 FROM user_master"))return {rows:[{}]};
        if(sql.includes("SELECT * FROM capex_workflow_step"))return {rows:stages()};
        return {rows:[]};
    }};
    const result=await workflow.snapshot(client,7,20);
    assert.equal(result.length,2);
    assert.match(calls[0].sql,/organizationid = \$1[\s\S]*'CAPEX'[\s\S]*isactive = TRUE[\s\S]*FOR SHARE/);
    assert.equal(calls.filter(c=>c.sql.includes("INSERT INTO capex_workflow_step")).length,2);
    assert.ok(!calls.some(c=>c.sql.includes("Capex_Approval_Config")));
});
for (const invalid of ["empty","duplicate","optional","user","missing recipient"]) {
    test("Snapshot fails safely for " + invalid + " configuration", async () => {
        const rows=stages().map(s=>({...s,approvalid:s.sourceid}));
        if(invalid==="empty") rows.length=0;
        if(invalid==="duplicate")rows[1].level=1;
        if(invalid==="optional")rows[0].ismandatory=false;
        if(invalid==="user")rows[0].approvertype="USER";
        const calls=[];
        const client={query:async(sql)=>{
            calls.push(sql);
            if(sql.includes("SELECT approvalmasterid"))return {rows:[{approvalmasterid:"6"}]};
            if(sql.includes("SELECT approvalid"))return {rows};
            if(sql.includes("SELECT 1 FROM user_master"))return {rows:invalid==="missing recipient"?[]:[{}]};
            return {rows:[]};
        }};
        await assert.rejects(workflow.snapshot(client,7,20));
        assert.ok(!calls.some(sql=>/^\s*INSERT/.test(sql)));
    });
}
test("Void requests cannot be approved",async()=>{
    await assert.rejects(workflow.applyAction(actionClient(stages()),{...capex,isvoid:true},{UserID:9,Action:"APPROVE"}),/Void/);
});
test("List and grouped PDF layouts consume the same read model as APIs",async()=>{
    const captures=[];
    const row=read.mapRow({...capex,steps:stages(),dynamic:true,actorrole:"GM",workflowstatus:"Pending"},9);
    const service=loadService({}, {}, async()=>{}, {
        "./CapexWorkflowRead":{
            list:async()=>({success:true,data:[row],TotalPages:1}),
            report:async()=>[{department:"Engineering",organizationid:20,shortname:"TEST",count:1,totalamount:10,pendingcount:1}]
        },
        "../../utils/pdfHelper":{generatePdf:async config=>{captures.push(config);return Buffer.from("PDF");},loadLogo:async()=>null}
    });
    assert.equal((await service.generateCapexListPdf({UserID:9,OrganizationID:20})).success,true);
    assert.ok(captures[0].columns.some(column=>column.header==="GM"));
    assert.ok(captures[0].columns.some(column=>column.header==="CEO"));
    assert.ok(!captures[0].columns.some(column=>column.header==="OWNER"));
    assert.equal((await service.getCapexDepartmentReportPdf({UserID:9,Filters:{}})).success,true);
    assert.equal((await service.getCapexOrganizationReportPdf({UserID:9,Filters:{}})).success,true);
    assert.equal(captures.length,3);
});
