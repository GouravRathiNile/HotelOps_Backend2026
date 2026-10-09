const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const root = path.resolve(__dirname, "../..");
function load(file, mocks = {}) {
    const full = path.join(root, file);
    const context = { module: { exports: {} }, console };
    context.exports = context.module.exports;
    context.require = name => Object.hasOwn(mocks, name) ? mocks[name] :
        require(name.startsWith(".") ? path.resolve(path.dirname(full), name) : name);
    vm.runInNewContext(fs.readFileSync(full, "utf8"), context, { filename: full });
    return context.module.exports;
}
const plain = value => JSON.parse(JSON.stringify(value));
const input = { OrganizationID: 2, FlowName: "Test", ModuleName: "Gatepass", UserID: 9,
    Details: [{ Level: 1, ApproverType: "Role", Role: "HOD", ApprovalType: "Sequential" }] };
function service(options = {}) {
    const calls = [];
    const query = async (sql, params) => {
        calls.push({ sql, params });
        if (options.fail && sql.includes(options.fail)) throw new Error("database failure");
        if (sql.includes("FOR UPDATE")) return { rows: options.missing ? [] : [{ approvalmasterid: 7, isactive: false }] };
        if (sql.includes("LIMIT 1")) return { rows: options.duplicate ? [{ approvalmasterid: 8 }] : [] };
        if (sql.includes("INSERT INTO public.approval_master\n")) return { rows: [{ approvalmasterid: 7 }] };
        if (sql.includes("COUNT(*)")) return { rows: [{ totalcount: "1" }] };
        if (sql.includes("RETURNING approvalmasterid")) return { rows: options.missing ? [] : [{ approvalmasterid: 7 }] };
        if (sql.includes("SELECT am.")) return { rows: [{ approvalmasterid: 7, organizationid: 2, details: [{ level: 1 }] }] };
        return { rows: [] };
    };
    let released = false;
    const pool = { query, connect: async () => {
        if (options.connectionFailure) throw Object.assign(new Error("offline"), { code: "ECONNREFUSED" });
        return { query, release: () => { released = true; } };
    } };
    return { api: load("services/FlowBuilderService/ApprovalFlowService.js", { "../../db": { pool } }),
        calls, released: () => released };
}
test("Save creates master and levels, defaults active and returns success after commit", async () => {
    const s = service();
    const result = await s.api.saveApprovalFlow(input);
    assert.deepEqual(plain(result), { success: true, message: "Approval Flow Created Successfully" });
    assert.equal(s.calls.find(c => c.sql.includes("INSERT INTO public.approval_master\n")).params[4], true);
    assert.equal(s.calls.at(-1).sql, "COMMIT");
    assert.ok(s.released());
});
for (const active of [false, true, undefined]) {
    test("Save updates scoped master and replaces levels; IsActive=" + active, async () => {
        const s = service();
        const result = await s.api.saveApprovalFlow({ ...input, ApprovalMasterID: 7, IsActive: active });
        assert.deepEqual(plain(result), { success: true, message: "Approval Flow Updated Successfully" });
        const update = s.calls.find(c => c.sql.includes("UPDATE public.approval_master SET"));
        assert.deepEqual(plain(update.params.slice(3)), [active ?? false, 9, 7, 2]);
        assert.ok(s.calls.some(c => c.sql.includes("deletedby = $1")));
        assert.equal(s.calls.at(-1).sql, "COMMIT");
    });
}
test("Unknown or another organization's master does not fall back to create", async () => {
    const s = service({ missing: true });
    assert.equal((await s.api.saveApprovalFlow({ ...input, ApprovalMasterID: 7 })).statusCode, 404);
    const lock = s.calls.find(c => c.sql.includes("FOR UPDATE"));
    assert.match(lock.sql, /organizationid = \$2/);
    assert.deepEqual(plain(lock.params), [7, 2]);
    assert.ok(!s.calls.some(c => c.sql.includes("INSERT")));
    assert.equal(s.calls.at(-1).sql, "ROLLBACK");
});
test("Duplicate module is rejected within the organization", async () => {
    const s = service({ duplicate: true });
    assert.equal((await s.api.saveApprovalFlow(input)).statusCode, 409);
    assert.deepEqual(plain(s.calls.find(c => c.sql.includes("LIMIT 1")).params), [2, "Gatepass", null]);
    assert.equal(s.calls.at(-1).sql, "ROLLBACK");
});
test("Detail failure rolls back master changes and releases client", async () => {
    const s = service({ fail: "INSERT INTO public.approval_master_details" });
    assert.equal((await s.api.saveApprovalFlow(input)).success, false);
    assert.equal(s.calls.at(-1).sql, "ROLLBACK");
    assert.ok(!s.calls.some(c => c.sql === "COMMIT"));
    assert.ok(s.released());
});
test("Connection failure preserves queue retry response", async () => {
    const s = service({ connectionFailure: true });
    assert.deepEqual(plain(await s.api.saveApprovalFlow(input)), { success: false, retry: true });
});
test("List includes live ordered levels, scoped filters and master pagination", async () => {
    const s = service();
    const result = await s.api.getApprovalFlowList({ OrganizationID: 2, ApprovalMasterID: 7, IsActive: "false", page: 2, PageSize: 5 });
    const query = s.calls.find(c => c.sql.includes("SELECT am."));
    assert.match(query.sql, /am.organizationid = \$1/);
    assert.match(query.sql, /d.approvalmasterid = am.approvalmasterid AND d.isdelete = FALSE/);
    assert.match(query.sql, /ORDER BY levels.level, levels.approvalid/);
    assert.match(query.sql, /to_jsonb\(levels\) - 'approvalid'/);
    assert.doesNotMatch(query.sql, /\b(?:createdby|modifiedby|modifieddatetime)\b/);
    assert.doesNotMatch(query.sql, /d\.approvalmasterid,/);
    const masterSelection = query.sql.slice(0, query.sql.indexOf("COALESCE"));
    assert.deepEqual(masterSelection.match(/am\.\w+/g), [
        "am.approvalmasterid", "am.organizationid", "am.flowname",
        "am.modulename", "am.description", "am.isactive", "am.createddatetime"
    ]);
    assert.match(query.sql, /'\[\]'::jsonb/);
    assert.deepEqual(plain(query.params), [2, 7, false, 5, 5]);
    assert.equal(result.data[0].details.length, 1);
    assert.equal(result.CurrentPage, 2);
    assert.equal(result.TotalCount, 1);
});
test("Every service operation rejects missing organization before querying", async () => {
    const s = service();
    for (const name of Object.keys(s.api)) {
        assert.equal((await s.api[name]({ ...input, OrganizationID: undefined })).statusCode, 400);
    }
    assert.equal(s.calls.length, 0);
});
test("Save rejects invalid IDs and string boolean values", async () => {
    const s = service();
    for (const fields of [{ ApprovalMasterID: "" }, { OrganizationID: true }, { IsActive: "false" }, { Details: [] }]) {
        assert.equal((await s.api.saveApprovalFlow({ ...input, ...fields })).statusCode, 400);
    }
    assert.equal(s.calls.length, 0);
});
test("Delete remains scoped and soft deletes master", async () => {
    const s = service();
    assert.equal((await s.api.deleteApprovalFlow({ OrganizationID: 2, ApprovalMasterID: 7, DeletedBy: 9 })).success, true);
    assert.match(s.calls[0].sql, /organizationid = \$3 AND isdelete = FALSE/);
    assert.deepEqual(plain(s.calls[0].params), [9, 7, 2]);
});
test("Handler exposes only save/list/delete actions", async () => {
    const calls = [];
    const handler = load("consumer/FlowBuilderConsumer/ApprovalFlowHandler.js", {
        "../../services/FlowBuilderService/ApprovalFlowService": Object.fromEntries(
            ["saveApprovalFlow", "getApprovalFlowList", "deleteApprovalFlow"].map(name =>
                [name, async data => { calls.push([name, data]); return { success: true }; }]))
    });
    for (const action of ["SAVE_APPROVAL_FLOW", "GET_APPROVAL_FLOW_LIST", "DELETE_APPROVAL_FLOW"]) {
        assert.equal((await handler({ action, data: input })).success, true);
    }
    for (const action of ["CREATE_APPROVAL_FLOW", "UPDATE_APPROVAL_FLOW", "GET_APPROVAL_FLOW_DETAILS", "UPDATE_APPROVAL_FLOW_STATUS"]) {
        assert.equal((await handler({ action, data: input })).statusCode, 400);
    }
    assert.equal(calls.length, 3);
});
test("Router registers authenticated save/list/delete only", () => {
    const registrations = [];
    const router = Object.fromEntries(["post", "get", "put", "delete", "patch"].map(method =>
        [method, (...args) => registrations.push([method, ...args])]));
    const auth = () => {};
    load("routes/FlowBuilderRoutes/ApprovalFlowRoutes.js", {
        express: { Router: () => router }, "../../middleware/authMiddleware": auth,
        "../../controllers/FlowBuilderController/ApprovalFlowController": {
            saveApprovalFlow() {}, getApprovalFlowList() {}, deleteApprovalFlow() {}
        }
    });
    assert.deepEqual(registrations.map(r => r.slice(0, 2)), [["post", "/save"], ["get", "/list"], ["delete", "/delete"]]);
    assert.ok(registrations.every(r => r[2] === auth && typeof r[3] === "function"));
});
test("Controller sends normalized Save with authenticated actor and propagates created response", async () => {
    let request;
    const controller = load("controllers/FlowBuilderController/ApprovalFlowController.js", {
        "../../producer/producer": { sendMessage: async (...args) => {
            request = args.at(-1); return { success: true, statusCode: 201 };
        } }
    });
    const res = { status(value) { this.code = value; return this; }, json(value) { this.body = value; return this; } };
    await controller.saveApprovalFlow({ body: { ...input, UserID: 999, IsActive: false }, user: { UserID: 9 } }, res);
    assert.equal(request.action, "SAVE_APPROVAL_FLOW");
    assert.equal(request.data.UserID, 9);
    assert.equal(request.data.IsActive, false);
    assert.equal(res.code, 201);
});

test("Controller rejects missing organization before dispatch and propagates service errors", async () => {
    let calls = 0;
    const controller = load("controllers/FlowBuilderController/ApprovalFlowController.js", {
        "../../producer/producer": { sendMessage: async () => {
            calls++;
            return { success: false, statusCode: 404, message: "Approval Flow Not Found" };
        } },
        "../../utils/errorHandler": (error, res) => res.status(error.statusCode).json({ message: error.message })
    });
    const res = { status(value) { this.code = value; return this; }, json(value) { this.body = value; return this; } };
    await controller.getApprovalFlowList({ query: {} }, res);
    assert.equal(res.code, 400);
    assert.equal(calls, 0);
    await controller.saveApprovalFlow({ body: { ...input, ApprovalMasterID: 7 }, user: { UserID: 9 } }, res);
    assert.equal(res.code, 404);
    assert.equal(calls, 1);
});

test("Postman collection documents only supported endpoints and complete responses", () => {
    const collection = JSON.parse(fs.readFileSync(path.join(root, "docs/ApprovalFlow.postman_collection.json"), "utf8"));
    assert.equal(collection.auth.type, "bearer");
    for (const item of collection.item) {
        assert.match(item.request.url, /\/api\/ApprovalFlow\/(save|list|delete)(\?|$)/);
        const response = JSON.parse(item.response[0].body);
        if (item.request.method === "GET") {
            assert.ok(Array.isArray(response.data[0].details));
            assert.ok(item.request.url.includes("OrganizationID="));
        } else {
            assert.ok(JSON.parse(item.request.body.raw).OrganizationID);
        }
    }
});

