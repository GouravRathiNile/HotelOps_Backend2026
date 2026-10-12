const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

// Opt-in only. The migration, fixture and every action are rolled back.
// No service notification entry point is called.
test("PostgreSQL snapshot, actions, read model and legacy coexistence", {
    skip: process.env.CAPEX_WORKFLOW_DB_TEST !== "1", timeout: 60000
}, async () => {
    const { pool } = require("../../db");
    const workflow = require("../../services/CapexService/CapexWorkflow");
    const read = require("../../services/CapexService/CapexWorkflowRead");
    const organizationID = Number(process.env.CAPEX_TEST_ORGANIZATION_ID);
    assert.ok(Number.isSafeInteger(organizationID) && organizationID > 0,
        "Set CAPEX_TEST_ORGANIZATION_ID to an organization with a verified mandatory flow");
    const client = await pool.connect();
    const originalQuery = pool.query;
    try {
        await client.query("BEGIN");
        await client.query("SET LOCAL lock_timeout = '5s'");
        const migration = fs.readFileSync(path.resolve(__dirname,
            "../../docs/migrations/capex-dynamic-workflow.sql"), "utf8");
        await client.query(migration.replace(/^BEGIN;|^COMMIT;/gm, ""));
        const config = await client.query(`
            SELECT d.* FROM approval_master am
            JOIN approval_master_details d ON d.approvalmasterid = am.approvalmasterid
            WHERE am.organizationid = $1 AND UPPER(TRIM(am.modulename)) = 'CAPEX'
              AND am.isactive = TRUE AND am.isdelete = FALSE AND d.isdelete = FALSE
            ORDER BY d.level
        `, [organizationID]);
        assert.ok(config.rows.length >= 2);
        assert.ok(config.rows.every(s => ["ROLE", "USER"].includes(s.approvertype) && s.ismandatory));
        const actors = [];
        for (const step of config.rows) {
            const result = await client.query(`
                SELECT um.userid FROM user_master um JOIN user_org_mapping uom ON uom.userid = um.userid
                WHERE uom.organizationid = $1 AND (($3 = 'ROLE' AND UPPER(TRIM(um.usertype)) = UPPER(TRIM($2))) OR ($3 = 'USER' AND um.userid::text = $2))
                  AND um.isactive AND NOT um.isdeleted AND NOT um.islocked
                  AND uom.isactive AND NOT uom.isdeleted LIMIT 1
            `, [organizationID, step.role, step.approvertype]);
            assert.ok(result.rows.length, "Configured role has no eligible actor");
            actors.push(result.rows[0].userid);
        }
        // Match the application's ID locks so a concurrent submission cannot
        // reserve the same fixture ID. All fixture writes remain uncommitted.
        await client.query("SELECT pg_advisory_xact_lock(hashtext('Capex_Master.CapexID'))");
        const id = (await client.query("SELECT COALESCE(MAX(capexid),0)+1 AS id FROM capex_master")).rows[0].id;
        const number = (await client.query(`
            INSERT INTO capex_organization_sequence(organizationid,lastcapexnumber) VALUES($1,1)
            ON CONFLICT(organizationid) DO UPDATE
                SET lastcapexnumber=capex_organization_sequence.lastcapexnumber+1
            RETURNING lastcapexnumber
        `, [organizationID])).rows[0].lastcapexnumber;
        await client.query(`
            INSERT INTO capex_master(capexid,organizationid,capexnumber,department,item,qty,rate,total,createdby)
            VALUES($1,$2,$3,'Engineering','Rollback-only workflow test',2,10,20,$4)
        `, [id,organizationID,number,actors[0]]);
        await client.query("SELECT pg_advisory_xact_lock(hashtext('Capex_Approval.CapexApprovalID'))");
        await client.query(`
            INSERT INTO capex_approval(capexapprovalid,capexid,gmstatus,ceostatus,ownerstatus,finalstatus,createdby)
            SELECT COALESCE(MAX(capexapprovalid),0)+1,$1,'Pending','Pending','Pending','Pending',$2
            FROM capex_approval
        `, [id,actors[0]]);
        const steps = await workflow.snapshot(client,id,organizationID);
        assert.equal(steps.length,config.rows.length);
        const capex = {capexid:id,organizationid:organizationID,createdby:actors[0],isvoid:false};
        const permissionsFor = async userID => {
            const query = read.buildQuery({UserID:userID,CapexID:id}, false);
            const result = await client.query(query.cte + " SELECT r.* FROM records r " + query.where, query.values);
            return read.mapRow(result.rows[0],userID);
        };
        assert.equal((await permissionsFor(actors[0])).CanAction,true);
        assert.equal((await permissionsFor(actors[0])).CanApprove,true);
        if (String(actors[0]) !== String(actors[1])) {
            assert.equal((await permissionsFor(actors[1])).CanApprove,false);
        }
        for (const Action of ["HOLD","RETURN","REJECT","APPROVE"]) {
            await workflow.applyAction(client,capex,{
                UserID:actors[0],Action,Remarks:"Integration check",Quantity:2,ApprovalStepID:steps[0].stepid
            });
            assert.equal((await permissionsFor(actors[0])).CanAction,false);
        }
        assert.equal((await permissionsFor(actors[1])).CanApprove,true);
        for (let i=1;i<steps.length;i++) {
            await workflow.applyAction(client,capex,{UserID:actors[i],Action:"APPROVE",Quantity:2,ApprovalStepID:steps[i].stepid});
        }
        const history=await client.query(`
            SELECT a.* FROM capex_workflow_action a
            JOIN capex_workflow_step s ON s.stepid=a.stepid WHERE s.capexid=$1
        `,[id]);
        assert.equal(history.rows.length,steps.length+3);
        // Serialize queries on this single transaction client.
        let queue=Promise.resolve();
        pool.query=(...args)=>{
            const result=queue.then(()=>client.query(...args));
            queue=result.catch(()=>{});
            return result;
        };
        const detail=await read.detail({UserID:actors[0],CapexID:id});
        assert.equal(detail.data.CurrentStatus,"Approved");
        assert.equal(detail.data.CurrentApprovalStepID,null);
        assert.equal(detail.data.Approvals.length,steps.length);
        assert.ok(detail.data.Approvals.every(s=>s.Status==="Approved" && s.ApprovedQuantity===2));
        const list=await read.list({UserID:actors[0],OrganizationID:organizationID,CapexID:id});
        assert.equal(list.TotalCount,1);
        assert.equal(list.ApprovalColumns.length,steps.length);
        for (const grouping of [null,"department","organization"]) {
            const rows=await read.report({UserID:actors[0],OrganizationID:organizationID,CapexID:id},grouping);
            assert.equal(Number(rows[0].approvedcount),1);
        }
        const isolated=await read.list({UserID:actors[0],OrganizationID:-1});
        assert.equal(isolated.TotalCount,0);
        const legacy=await read.list({UserID:actors[0],OrganizationID:organizationID,PageSize:1000});
        assert.ok(legacy.data.some(row=>row.WorkflowSource==="LEGACY"));
    } finally {
        pool.query=originalQuery;
        await client.query("ROLLBACK");
        client.release();
        await pool.end();
    }
});
