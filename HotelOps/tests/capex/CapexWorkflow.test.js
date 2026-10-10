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
        test(status + " current step validates " + action, () => {
            const steps = stages(); steps[0].status = status;
            if (status === "Pending") assert.equal(workflow.chooseStep(steps, gm, action).stepid, "1");
            else assert.throws(() => workflow.chooseStep(steps, gm, action), /not authorized/);
            assert.throws(() => workflow.chooseStep(steps, ceo, action), /not authorized/);
        });
    }
}
test("Previous approved step cannot act after workflow advances", () => {
    const steps = stages(); steps[0].status = "Approved";
    for (const action of ["REJECT","RETURN"]) assert.ok(!workflow.canAct(steps, steps[0], action));
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
    assert.equal(result.CanApprove,false);
    assert.deepEqual(result.Approvals[0].AllowedActions,[]);
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
        if(sql.includes("FROM approval_master am"))return {rows:[{columnkey:"stage:GM:1",label:"GM",level:1}]};
        if(sql.includes("SELECT r.*"))return {rows:[{...capex,steps:stages(),dynamic:true,actorrole:"GM",workflowstatus:"Pending"}]};
        return {rows:[]};
    };
    try{
        const result=await read.list({UserID:9,OrganizationID:20});
        assert.equal(result.TotalCount,1);assert.equal(result.ApprovalColumns[0].Key,"stage:GM:1");
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
for (const invalid of ["empty","duplicate","user","missing recipient"]) {
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

test("Builder USER selection is snapshotted as a user ID, not a role", async () => {
    const calls=[];
    const client={query:async(sql,values)=>{
        calls.push({sql,values});
        if(sql.includes("SELECT approvalmasterid"))return {rows:[{approvalmasterid:"6",flowname:"CAPEX"}]};
        if(sql.includes("SELECT approvalid"))return {rows:[
            {approvalid:"48",level:1,approvertype:"USER",role:"7",approvaltype:"CEO",ismandatory:true}
        ]};
        if(sql.includes("SELECT 1 FROM user_master"))return {rows:[{}]};
        return {rows:[]};
    }};
    await workflow.snapshot(client,7,20);
    assert.deepEqual(calls.find(c=>c.sql.includes("SELECT 1 FROM user_master")).values,[20,"USER","7"]);
    assert.deepEqual(calls.find(c=>c.sql.includes("INSERT INTO capex_workflow_step")).values,
        [7,"48",1,"USER",null,"CEO",true,"7"]);
});

test("GM approval targets only the selected CEO user; selected user can give final approval", async () => {
    const steps=stages();
    steps[1]={...steps[1],approvertype:"USER",role:null,assigneduserid:"7"};
    const first=await workflow.applyAction(actionClient(steps),capex,{UserID:9,Action:"APPROVE"});
    assert.deepEqual(first.roles,[]);
    assert.deepEqual(first.directUserIds,["7"]);
    assert.throws(()=>workflow.chooseStep(steps,ceo,"APPROVE"),/not authorized/);
    const selected={userid:"7",usertype:"OTHER"};
    const row=read.mapRow({...capex,steps,dynamic:true,actorrole:"OTHER"},7);
    assert.equal(row.CanApprove,true);
    assert.equal(row.CurrentApprovalStage,"CEO");
    const last=await workflow.applyAction(actionClient(steps,selected),capex,{UserID:7,Action:"APPROVE"});
    assert.equal(last.finalStatus,"Approved");
    assert.deepEqual(last.directUserIds,["3"]);
});

test("Selected user must be eligible in the request organization", async () => {
    const client={query:async(sql)=>{
        if(sql.includes("SELECT approvalmasterid"))return {rows:[{approvalmasterid:"6"}]};
        if(sql.includes("SELECT approvalid"))return {rows:[
            {approvalid:"48",level:1,approvertype:"USER",role:"7",approvaltype:"CEO",ismandatory:true}
        ]};
        return {rows:[]};
    }};
    await assert.rejects(workflow.snapshot(client,7,20),/unavailable or not mapped/);
});

test("Edit/delete belongs to creator or same-organization department HOD before any action",()=>{
    const record={...capex,department:"Engineering",hasaction:false};
    const creator={userid:3,usertype:"STAFF"};
    const hod={userid:8,usertype:"HOD",departmentname:" engineering ",departmentorganizationid:20};
    assert.equal(workflow.canModify(record,creator),true);
    assert.equal(workflow.canModify(record,hod),true);
    assert.equal(workflow.canModify(record,{...hod,departmentname:"Finance"}),false);
    assert.equal(workflow.canModify(record,{...hod,departmentorganizationid:21}),false);
    assert.equal(workflow.canModify(record,gm),false);
    for(const actor of [creator,hod]){
        assert.equal(workflow.canModify({...record,hasaction:true},actor),false);
        assert.equal(workflow.canModify({...record,isvoid:true},actor),false);
        assert.equal(workflow.canModify({...record,isdeleted:true},actor),false);
    }
});

test("GM then selected FC then CEO: only the current configured assignee can approve",()=>{
    const steps=[
        {...stages()[0]},
        {...stages()[1],approvertype:"USER",assigneduserid:7,role:null,approvaltype:"FC"},
        {...stages()[1],stepid:"3",level:4}
    ];
    const actors=[gm,{userid:7,usertype:"STAFF"},ceo,{userid:55,usertype:"FC"}];
    for(let current=0;current<steps.length;current++){
        for(let index=0;index<actors.length;index++){
            const flags=workflow.permissions(capex,steps,actors[index]);
            assert.equal(flags.CanApprove,index===current);
            const mapped=read.mapRow({...capex,steps,actorrole:actors[index].usertype},actors[index].userid);
            mapped.Approvals.forEach((step,stepIndex)=>{
                assert.equal(step.CanApprove,index===current && stepIndex===current);
                if(index!==current || stepIndex!==current)assert.deepEqual(step.AllowedActions,[]);
            });
            if(index!==current) assert.throws(()=>workflow.authorizeApproval(capex,steps,actors[index],"APPROVE"));
        }
        steps[current].status="Approved";
    }
    assert.ok(actors.every(actor=>!workflow.permissions(capex,steps,actor).CanApprove));
});

for (const operation of ["updateCapex","deleteCapex"]) {
    for (const actionTaken of [false,true]) {
        test(operation+" department HOD "+(actionTaken?"denied after action":"allowed before action"),async()=>{
            const calls=[];
            const client={query:async(sql)=>{
                calls.push(sql);
                if(sql.includes("SELECT cm.organizationid, cm.createdby"))return {rows:[
                    {...capex,department:"Engineering",hasaction:actionTaken}
                ]};
                if(sql.includes("SELECT um.userid"))return {rows:[
                    {userid:8,usertype:"HOD",departmentname:"Engineering",departmentorganizationid:20}
                ]};
                if(/UPDATE Capex_Master/.test(sql))return {rows:[{capexid:7,organizationid:20,capexnumber:1}]};
                return {rows:[]};
            },release(){}};
            const service=loadService(client,workflow,async()=>({success:true}));
            const result=await service[operation]({CapexID:7,UserID:8,Changes:{Item:"Updated"},Documents:[],DeleteDocumentIDs:[]});
            assert.equal(result.success,!actionTaken);
            assert.ok(calls.includes(actionTaken?"ROLLBACK":"COMMIT"));
            if(actionTaken)assert.ok(!calls.some(sql=>/^\s*UPDATE/.test(sql)));
        });
    }
}

for (const status of ["Pending","Rejected","Returned","Hold","Approved"]) {
    test("Permission flags and API policy agree for " + status, () => {
        const steps=stages();steps[0].status=status;
        const record={...capex,createdby:"3",hasaction:status!=="Pending"};
        const flags=workflow.permissions(record,steps,gm);
        assert.equal(flags.CanAction,false);
        assert.equal(flags.CanApprove,status==="Pending");
        assert.equal(workflow.permissions(record,steps,{userid:"3",usertype:"UNASSIGNED"}).CanAction,status==="Pending");
        assert.equal(workflow.permissions(record,steps,{userid:"3",usertype:"UNASSIGNED"}).CanApprove,false);
        if(flags.CanApprove) assert.equal(workflow.authorizeApproval(record,steps,gm,"APPROVE").stepid,"1");
        else assert.throws(()=>workflow.authorizeApproval(record,steps,gm,"APPROVE"));
    });
}
test("Void/deleted/final requests deny approval and malformed identities never grant ownership",()=>{
    for(const override of [{isvoid:true},{isdeleted:true},{finalstatus:"Approved"}]) {
        const record={...capex,...override};
        assert.equal(workflow.permissions(record,stages(),gm).CanApprove,false);
        assert.throws(()=>workflow.authorizeApproval(record,stages(),gm,"APPROVE"));
    }
    assert.equal(workflow.canModify({},{}),false);
    assert.equal(workflow.isAssigned({approvertype:"ROLE",role:""},gm),false);
});

for (const operation of ["updateCapex","deleteCapex"]) {
    test(operation + " rejects a noncreator even with a privileged-looking role",async()=>{
        const calls=[];
        const client={query:async(sql)=>{
            calls.push(sql);
            if(sql.includes("SELECT cm.organizationid, cm.createdby"))return {rows:[{organizationid:20,createdby:3}]};
            if(sql.includes("SELECT um.userid"))return {rows:[gm]};
            return {rows:[]};
        },release(){}};
        const service=loadService(client,workflow,async()=>{});
        const result=await service[operation]({CapexID:7,UserID:9,Changes:{Item:"Forbidden"}});
        assert.equal(result.statusCode,403);
        assert.ok(calls.includes("ROLLBACK"));
        assert.ok(!calls.some(sql=>/^\s*UPDATE/.test(sql)));
    });
}
for (const authorized of [true,false]) {
    test("Legacy approval backend " + (authorized?"allows":"rejects") + " persisted assignment",async()=>{
        const calls=[];
        const client={query:async(sql)=>{
            calls.push(sql);
            if(sql.includes("FROM Capex_Master cm"))return {rows:[capex]};
            if(sql.includes("SELECT um.userid"))return {rows:[authorized?gm:{userid:9,usertype:"UNASSIGNED"}]};
            if(sql.includes("FROM Capex_Approval_Config"))return {rows:[
                {approvallevel:1,approvalrole:"GM",approvalorder:1,ismandatory:true},
                {approvallevel:2,approvalrole:"CEO",approvalorder:2,ismandatory:true}
            ]};
            if(sql.includes("FROM Capex_Approval"))return {rows:[
                {capexapprovalid:1,gmstatus:"Pending",ceostatus:"Pending",finalstatus:"Pending"}
            ]};
            return {rows:[]};
        },release(){}};
        const service=loadService(client,workflow,async()=>({success:true}));
        const result=await service.processCapexApproval({CapexID:7,UserID:9,UserType:"GM",Action:"APPROVE"});
        await new Promise(resolve=>setImmediate(resolve));
        assert.equal(result.success,authorized);
        assert.ok(calls.includes(authorized?"COMMIT":"ROLLBACK"));
    });
}
test("List and grouped PDF layouts consume the same read model as APIs",async()=>{
    const captures=[];
    const row=read.mapRow({...capex,steps:stages(),dynamic:true,actorrole:"GM",workflowstatus:"Pending"},9);
    const service=loadService({}, {}, async()=>{}, {
        "./CapexWorkflowRead":{
            list:async()=>({success:true,data:[row],TotalPages:1,ApprovalColumns:[
                {Key:"stage:GM:1",Label:"GM"},{Key:"stage:FC:1",Label:"FC"},{Key:"stage:CEO:1",Label:"CEO"}
            ]}),
            report:async()=>[{department:"Engineering",organizationid:20,shortname:"TEST",count:1,totalamount:10,pendingcount:1}]
        },
        "../../utils/pdfHelper":{generatePdf:async config=>{captures.push(config);return Buffer.from("PDF");},loadLogo:async()=>null}
    });
    assert.equal((await service.generateCapexListPdf({UserID:9,OrganizationID:20})).success,true);
    assert.ok(captures[0].columns.some(column=>column.header==="GM"));
    assert.ok(captures[0].columns.some(column=>column.header==="CEO"));
    assert.deepEqual(Array.from(captures[0].columns.slice(-3),column=>column.header),["GM","FC","CEO"]);
    assert.ok(!captures[0].columns.some(column=>column.header==="OWNER"));
    assert.equal((await service.getCapexDepartmentReportPdf({UserID:9,Filters:{}})).success,true);
    assert.equal((await service.getCapexOrganizationReportPdf({UserID:9,Filters:{}})).success,true);
    assert.equal(captures.length,3);
});


test("Display columns align saved flow versions and legacy stages without changing action IDs", () => {
    const versions = ["11", "25", "39", "42", "56"];
    const rows = versions.map(sourceid => read.mapRow({ ...capex, dynamic: true,
        steps: [{ ...stages()[0], sourceid, stepid: sourceid, status: "Approved", approvedquantity: 2, remarks: sourceid }]
    }, 9));
    rows.push(read.mapRow({ ...capex, dynamic: false,
        steps: [{ ...stages()[0], sourceid: "legacy:GM", stepid: "legacy:GM" }]
    }, 9));
    assert.deepEqual([...new Set(rows.flatMap(row => row.Approvals.map(step => step.ColumnKey)))], ["stage:GM:1"]);
    rows.slice(0, 5).forEach((row, index) => {
        assert.equal(row.Approvals[0].ApprovalStepID, versions[index]);
        assert.equal(row.Approvals[0].Remarks, versions[index]);
        assert.equal(row.Approvals[0].ApprovedQuantity, 2);
    });
});

test("Repeated business stages retain distinct columns and moved stages align across versions", () => {
    const row = read.mapRow({ ...capex, steps: [stages()[0],
        { ...stages()[1], approvaltype: " gm ", stepid: "3" },
        { ...stages()[1], level: 9, stepid: "4" }]
    }, 9);
    assert.deepEqual(row.Approvals.map(step => step.ColumnKey), ["stage:GM:1", "stage:GM:2", "stage:CEO:1"]);
    const previous = read.mapRow({ ...capex, steps: stages() }, 9);
    assert.equal(row.Approvals[2].ColumnKey, previous.Approvals[1].ColumnKey);
});


test("Configured headers stay ordered and identical across filters and empty pages", async () => {
    const original = pool.query;
    const labels = ["GM", "FC", "CEO", "OWNER"];
    const calls = [];
    pool.query = async (sql, values) => {
        if (sql.includes("FROM approval_master am")) {
            calls.push({sql, values});
            return {rows: labels.map((label, index) => ({columnkey: `stage:${label}:1`, label, level: index + 1}))};
        }
        if (sql.includes("SELECT COUNT(*) AS count")) return {rows: [{count: 0}]};
        return {rows: []};
    };
    try {
        for (const Status of ["", "Pending", "Approved", "Rejected", "Returned", "Hold", "Void"]) {
            const result = await read.list({UserID: 9, OrganizationID: 20, Status, page: 3});
            assert.deepEqual(result.ApprovalColumns.map(column => column.Label), labels);
            assert.deepEqual(result.data, []);
        }
        for (const {sql, values} of calls) {
            assert.deepEqual(values, [9, 20]);
            assert.match(sql, /am.organizationid = \$2/);
            assert.match(sql, /uom.organizationid = am.organizationid/);
            assert.match(sql, /am.isactive = TRUE AND am.isdelete = FALSE/);
            assert.match(sql, /ORDER BY d.level, d.approvalid/);
            assert.ok(!sql.includes("workflowstatus"));
        }
    } finally { pool.query = original; }
});


test("Optional stages at every position are bypassed; all optional means complete", () => {
    for (let mask = 0; mask < 8; mask++) {
        const steps = ["GM", "FC", "CEO"].map((role, i) => ({...stages()[0], stepid: String(i+1), role,
            level: i+1, approvaltype: role, ismandatory: Boolean(mask & (1 << i))}));
        for (const step of steps) {
            if (!step.ismandatory) {
                assert.equal(workflow.canAct(steps, step, "APPROVE"), false);
                continue;
            }
            assert.equal(workflow.currentStep(steps), step);
            for (const status of ["Rejected", "Returned", "Hold"]) {
                step.status = status; assert.equal(workflow.currentStep(steps), step);
            }
            step.status = "Approved";
        }
        assert.equal(workflow.currentStep(steps), null);
    }
});
test("Approving GM bypasses optional FC and notifies CEO; optional tail completes", async () => {
    for (const mandatoryCEO of [true, false]) {
        const steps = [stages()[0], {...stages()[1], stepid:"2",role:"FC",approvaltype:"FC",ismandatory:false},
            {...stages()[1],stepid:"3",ismandatory:mandatoryCEO}];
        const result = await workflow.applyAction(actionClient(steps),capex,{UserID:9,Action:"APPROVE",Quantity:1});
        assert.deepEqual(result.roles,mandatoryCEO ? ["CEO"] : []);
        assert.equal(result.finalStatus,mandatoryCEO ? null : "Approved");
        assert.deepEqual(result.directUserIds,mandatoryCEO ? [] : ["3"]);
    }
});


test("Snapshot accepts optional steps without eligible recipients and preserves their mandatory flag", async () => {
    const rows = stages().map(step => ({...step,approvalid:step.sourceid,ismandatory:false}));
    const calls=[];
    const client={query:async(sql,values)=>{
        calls.push({sql,values});
        if(sql.includes("SELECT approvalmasterid"))return {rows:[{approvalmasterid:"6"}]};
        if(sql.includes("SELECT approvalid"))return {rows};
        if(sql.includes("SELECT * FROM capex_workflow_step"))return {rows};
        return {rows:[]};
    }};
    const result=await workflow.snapshot(client,7,20);
    assert.equal(workflow.currentStep(result),null);
    assert.equal(calls.filter(c=>c.sql.includes("SELECT 1 FROM user_master")).length,0);
    assert.equal(calls.filter(c=>c.sql.includes("INSERT INTO capex_workflow_step")).length,2);
    const mapped=read.mapRow({...capex,steps:result,actorrole:"GM"},9);
    assert.ok(mapped.Approvals.every(step=>step.Status==="Skipped" && !step.CanApprove));
});


for (const action of ["APPROVE", "REJECT", "RETURN", "HOLD"]) {
    test(action + " consumes the step and denies every repeat action", async () => {
        const steps = stages();
        const client = actionClient(steps);
        await workflow.applyAction(client, capex, {UserID:9,Action:action,Quantity:1,Remarks:"Reviewed"});
        const mapped = read.mapRow({...capex,steps,actorrole:"GM"},9);
        assert.equal(mapped.CanApprove,false);
        assert.deepEqual(mapped.Approvals[0].AllowedActions,[]);
        for (const repeat of ["APPROVE","REJECT","RETURN","HOLD"]) {
            await assert.rejects(workflow.applyAction(client,capex,{UserID:9,Action:repeat,Quantity:1,Remarks:"Again"}),/not authorized/);
        }
        assert.equal(workflow.permissions(capex,steps,ceo).CanApprove,action==="APPROVE");
    });
}
test("Recorded action evidence denies a step even when its status is Pending", () => {
    for (const evidence of [{revision:1},{actionby:9},{actiondatetime:"2026-10-10"}]) {
        const steps=stages();Object.assign(steps[0],evidence);
        assert.equal(workflow.permissions(capex,steps,gm).CanApprove,false);
    }
});
test("Service-verified actor avoids a duplicate actor lookup",async()=>{
    const client=actionClient(stages());
    await workflow.applyAction(client,capex,{UserID:9,Action:"APPROVE",Quantity:1},gm);
    assert.ok(!client.calls.some(call=>call.sql.includes("SELECT um.userid")));
});
