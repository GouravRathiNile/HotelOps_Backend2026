const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// Real service SQL, isolated transaction. Queue commands are captured locally.
test("CAPEX Regional create/update, Builder reorder, authorization, transitions and notifications", {
    skip: process.env.CAPEX_REGIONAL_DB_TEST !== "1", timeout: 60000
}, async () => {
    const { pool } = require("../../db");
    const workflow = require("../../services/CapexService/CapexWorkflow");
    const read = require("../../services/CapexService/CapexWorkflowRead");
    const builder = require("../../services/FlowBuilderService/ApprovalFlowService");
    const client = await pool.connect();
    const originalConnect = pool.connect, originalQuery = pool.query;
    const sent = [];
    let queue = Promise.resolve();
    const query = (sql, values) => {
        const result = queue.then(() => client.query(sql, values));
        queue = result.catch(() => {});
        return result;
    };
    const flush = async () => {
        await new Promise(resolve => setImmediate(resolve));
        await queue;
        await new Promise(resolve => setImmediate(resolve));
    };
    try {
        await client.query("BEGIN");
        await client.query("SET LOCAL lock_timeout = '5s'");
        const migration = fs.readFileSync(path.resolve(__dirname,
            "../../docs/migrations/capex-regional-approvers.sql"), "utf8");
        await client.query(migration.replace(/^BEGIN;|^COMMIT;/gm, ""));
        // Discover fixtures from the configured flow; never bake tenant/user IDs into tests.
        const flow = (await client.query(`SELECT am.* FROM approval_master am
            WHERE UPPER(TRIM(am.modulename)) = 'CAPEX' AND am.isactive AND NOT am.isdelete
              AND EXISTS (SELECT 1 FROM approval_master_details d WHERE d.approvalmasterid = am.approvalmasterid
                AND d.approvertype = 'REGIONAL' AND d.ismandatory AND NOT d.isdelete)
            ORDER BY am.approvalmasterid LIMIT 1`)).rows[0];
        assert.ok(flow, "A configured CAPEX Regional flow is required");
        const configured = (await client.query(`SELECT * FROM approval_master_details
            WHERE approvalmasterid = $1 AND NOT isdelete ORDER BY level`, [flow.approvalmasterid])).rows;
        const regional = configured.find(s => s.approvertype === "REGIONAL");
        const creator = (await client.query(`SELECT um.userid FROM user_master um
            JOIN user_org_mapping uom USING(userid) WHERE uom.organizationid = $1
              AND uom.isactive AND NOT uom.isdeleted AND um.isactive AND NOT um.isdeleted AND NOT um.islocked
              AND um.userid::text <> $2 ORDER BY um.userid LIMIT 1`, [flow.organizationid, regional.role])).rows[0];
        assert.ok(creator);
        // Regional users must work without direct hotel membership.
        await client.query(`UPDATE user_org_mapping SET isactive = FALSE
            WHERE userid::text = $1 AND organizationid = $2`, [regional.role, flow.organizationid]);
        pool.query = query;
        pool.connect = async () => ({
            query: (sql, values) => query(sql === "BEGIN" ? "SAVEPOINT service_transaction"
                : sql === "COMMIT" ? "RELEASE SAVEPOINT service_transaction"
                : sql === "ROLLBACK" ? "ROLLBACK TO SAVEPOINT service_transaction" : sql, values),
            release() {}
        });
        const serviceFile = path.resolve(__dirname, "../../services/CapexService/CapexService.js");
        const context = { module: { exports: {} }, console, process, Buffer };
        context.require = name => name === "../../producer/producer"
            ? { sendMessage: async (...args) => { sent.push(args[2]); return { success: true }; } }
            : require(name.startsWith(".") ? path.resolve(path.dirname(serviceFile), name) : name);
        vm.runInNewContext(fs.readFileSync(serviceFile, "utf8"), context);
        const service = context.module.exports;
        const create = async () => {
            const result = await service.createCapex({ OrganizationID: flow.organizationid,
                CreatedBy: creator.userid, Department: "Engineering", Item: "Rollback Regional test",
                Description: "CAPEX compatibility", Make: "Test", Qty: 2, Rate: 10, Total: 20 });
            assert.equal(result.success, true, result.message);
            await flush();
            return (await query(`SELECT * FROM capex_master WHERE organizationid = $1
                ORDER BY capexid DESC LIMIT 1`, [flow.organizationid])).rows[0];
        };
        const old = await create();
        const oldSteps = await workflow.loadSteps(client, old.capexid);
        // Send an unsorted array: persisted Level, rather than input position or business stage, controls order.
        const reordered = [regional, ...configured.filter(s => s !== regional)];
        const details = reordered.map((s, i) => ({ Level: i + 1, ApproverType: s.approvertype,
            Role: s.role, ApprovalType: s.approvaltype, IsMandatory: s.ismandatory })).reverse();
        const saved = await builder.saveApprovalFlow({ OrganizationID: flow.organizationid,
            ApprovalMasterID: flow.approvalmasterid, FlowName: flow.flowname, ModuleName: flow.modulename,
            Details: details, UserID: creator.userid });
        assert.equal(saved.success, true, saved.message);
        assert.deepEqual(await workflow.loadSteps(client, old.capexid), oldSteps);
        const record = await create();
        const steps = await workflow.loadSteps(client, record.capexid);
        assert.deepEqual(steps.map(s => s.approvaltype), reordered.map(s => s.approvaltype));
        assert.equal(steps[0].approvertype, "REGIONAL");
        assert.ok(sent.at(-1).data.userIds.includes(regional.role), "Creation must notify selected Regional user");
        const edit = await service.updateCapex({ CapexID: record.capexid, UserID: creator.userid,
            Changes: { Description: "Updated before approval" } });
        assert.equal(edit.success, true, edit.message);
        const regionalRead = await read.detail({ UserID: regional.role, CapexID: record.capexid });
        assert.equal(regionalRead.data.CanApprove, true);
        assert.equal(regionalRead.data.CanAction, false);
        const regionalList = await read.list({ UserID: regional.role, CapexID: record.capexid, Status: "Pending" });
        assert.equal(regionalList.TotalCount, 1);
        const summary = await read.report({ UserID: regional.role, CapexID: record.capexid });
        assert.equal(Number(summary[0].pendingcount), 1);
        // Exercise the real device lookup SQL without contacting Firebase.
        const notificationFile = path.resolve(__dirname, "../../services/NotificationService/NotificationService.js");
        const pushContext = { module: { exports: {} }, console: { error: (...args) => assert.fail(args.join(" ")) }, process, Buffer };
        pushContext.require = name => name === "../../utils/sendPushNotification"
            ? { sendPushNotification: async () => {} }
            : require(name.startsWith(".") ? path.resolve(path.dirname(notificationFile), name) : name);
        vm.runInNewContext(fs.readFileSync(notificationFile, "utf8") +
            "\nmodule.exports.testPush = pushNotificationToRecipients;", pushContext);
        await pushContext.module.exports.testPush({ module_name: "Capex", entity_type: "Capex",
            entity_id: record.capexid, organization_id: record.organizationid }, [regional.role]);
        const deniedEdit = await service.updateCapex({ CapexID: record.capexid, UserID: regional.role,
            Changes: { Description: "Unauthorized" } });
        assert.equal(deniedEdit.statusCode, 403);
        const actor = await workflow.getActor(client, record.organizationid, regional.role, record.capexid);
        assert.equal(actor.organizationaccess, false);
        assert.equal(actor.regionaleligible, true);
        await assert.rejects(workflow.getActor(client, record.organizationid, regional.role), /access/);
        await assert.rejects(workflow.applyAction(client, record, { UserID: creator.userid,
            Action: "APPROVE", ApprovalStepID: steps[0].stepid }), /authorized|cannot/);
        const rejectedRecord = await create();
        const reject = await service.processCapexApproval({ CapexID: rejectedRecord.capexid,
            UserID: regional.role, Action: "REJECT", Remarks: "Rejected in test", Quantity: 2 });
        assert.equal(reject.success, true, reject.message);
        await flush();
        assert.deepEqual(Array.from(sent.at(-1).data.userIds), [String(creator.userid)]);
        await assert.rejects(workflow.applyAction(client, rejectedRecord,
            { UserID: regional.role, Action: "APPROVE" }), /authorized|cannot/);
        for (const step of steps.filter(s => s.ismandatory)) {
            const user = step.approvertype === "REGIONAL" ? regional.role
                : (await query(`SELECT um.userid FROM user_master um JOIN user_org_mapping uom USING(userid)
                    WHERE uom.organizationid = $1 AND uom.isactive AND NOT uom.isdeleted
                      AND um.isactive AND NOT um.isdeleted AND NOT um.islocked
                      AND (($2 = 'USER' AND um.userid::text = $3)
                        OR ($2 = 'ROLE' AND UPPER(TRIM(um.usertype)) = $3)) LIMIT 1`,
                    [flow.organizationid, step.approvertype, step.assigneduserid || step.role])).rows[0]?.userid;
            assert.ok(user, "Every mandatory assignment needs an eligible actor");
            const result = await service.processCapexApproval({ CapexID: record.capexid, UserID: user,
                Action: "APPROVE", Quantity: 2, ApprovalStepID: step.stepid, Revision: 0 });
            assert.equal(result.success, true, result.message);
            await flush();
            const persisted = await workflow.loadSteps(client, record.capexid);
            const next = workflow.currentStep(persisted);
            const event = sent.at(-1);
            if (next?.assigneduserid) assert.ok(event.data.userIds.includes(String(next.assigneduserid)));
            else if (!next) assert.ok(event.data.userIds.includes(String(creator.userid)));
        }
        const completed = await read.detail({ UserID: creator.userid, CapexID: record.capexid });
        assert.equal(completed.data.CurrentStatus, "Approved");
        assert.equal(completed.data.CanAction, false);
        const lockedEdit = await service.updateCapex({ CapexID: record.capexid, UserID: creator.userid,
            Changes: { Description: "Unauthorized after action" } });
        assert.equal(lockedEdit.statusCode, 403);
        const history = await query(`SELECT COUNT(*)::int AS count FROM capex_workflow_action a
            JOIN capex_workflow_step s USING(stepid) WHERE s.capexid = $1`, [record.capexid]);
        assert.equal(history.rows[0].count, steps.filter(s => s.ismandatory).length);
        // Losing company membership revokes approval even for a directly mapped hotel user.
        await query(`UPDATE user_primary_organization SET isactive = FALSE WHERE userid::text = $1`, [regional.role]);
        await assert.rejects(workflow.getActor(client, record.organizationid, regional.role, record.capexid), /access/);
    } finally {
        await flush();
        pool.connect = originalConnect;
        pool.query = originalQuery;
        await client.query("ROLLBACK");
        client.release();
        await pool.end();
    }
});
