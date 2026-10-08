const { normalizeRGPApprovalRole } = require("../../services/GatepassService/RGPApprovalRoles");
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname,
  "../../services/GatepassService/GatepassService.js"), "utf8");
const notificationSource = fs.readFileSync(path.join(__dirname,
  "../../services/GatepassService/GatepassNotificationService.js"), "utf8");
const master = { rgpid: 42, rgpnumber: 1007, organizationid: 20, departmentid: 7, createdby: 1, status: "PENDING" };
const stages = (stage) => ["HOD", "FC", "GM"].map((approvalrole, index) => ({
  rgpapprovalid: 101 + index, approvalorder: index + 1, approvallevel: index + 1,
  approvalrole, status: index < stage ? "Approved" : "Pending", actionby: index < stage ? index + 2 : null,
}));
const plain = (value) => JSON.parse(JSON.stringify(value));

function harness({ stage = 0, masterOverrides = {}, commitFailure = false,
  writeFailure = false, customFlow = [], notificationFailure = false, financeRole = "FC" } = {}) {
  const calls = [], events = [], deliveries = [];
  let committed = false, released = false, nextID = 101;
  const pool = { connect: async () => ({
    release: () => { released = true; calls.push({ sql: "RELEASE" }); },
    query: async (sql, params) => {
      calls.push({ sql: sql.trim(), params: plain(params || []) });
      if (sql === "COMMIT") {
        if (commitFailure) throw new Error("Commit failed");
        committed = true;
      }
      if (writeFailure && /UPDATE Gatepass_RGP_Approval|INSERT INTO Gatepass_RGP_Entry_Master/.test(sql)) {
        throw new Error("Write failed");
      }
      if (/FROM Organization_Master/.test(sql)) return { rows: [{ organizationid: 20 }] };
      if (/FROM Gatepass_RGP_Approval_Config/.test(sql)) return { rows: customFlow };
      if (/INSERT INTO Gatepass_RGP_Entry_Master\s/.test(sql)) return { rows: [{ ...master }] };
      if (/INSERT INTO Gatepass_RGP_Approval\s/.test(sql)) return { rows: [{ rgpapprovalid: nextID++,
        approvallevel: params[3], approvalrole: params[4], approvalorder: params[5], status: "Pending" }] };
      if (/FROM Gatepass_RGP_Entry_Master/.test(sql)) return { rows: [{ ...master, ...masterOverrides }] };
      if (/FROM Gatepass_RGP_Approval\s/.test(sql)) return { rows: stages(stage).map(row =>
        row.approvalrole === "FC" ? { ...row, approvalrole: financeRole } : row) };
      return { rows: [], rowCount: 1 };
    },
  }) };
  const notificationContext = { module: { exports: {} }, require: () => ({ pool: {}, normalizeRGPApprovalRole }),
    console: { error: () => {}, warn: () => {} } };
  vm.runInNewContext(notificationSource, notificationContext);
  const context = { pool, normalizeRGPApprovalRole, console: { error: () => {} },
    retryableDatabaseResponse: () => null,
    notifyCommittedRGPEvent: (event) => {
      assert.equal(committed, true, "Dispatch must follow a successful commit");
      assert.equal(released, true, "Do not hold a transaction connection during notification delivery");
      events.push(plain(event));
      deliveries.push(notificationContext.module.exports.notifyCommittedRGPEvent(event, {
        queryable: { query: async () => ({ rows: [{ userid: 9, shortname: "NH", rgpdepartmentname: "Engineering", itemnames: ["Pump"] }] }) },
        publishNotification: async () => {
          if (notificationFailure) throw new Error("RabbitMQ unavailable");
          return { success: true };
        },
      }));
    },
  };
  // Load the complete module, including its imports/exports, so a disconnected
  // dispatcher import cannot be hidden by testing extracted function bodies.
  context.module = { exports: {} };
  context.process = { cwd: () => path.resolve(__dirname, "../..") };
  context.require = (name) => {
    if (name === "../../db") return { pool };
    if (name === "./NRGPNotificationService") return {};
    if (name === "./RGPApprovalRoles") return { normalizeRGPApprovalRole };
    if (name === "./GatepassNotificationService") return { notifyCommittedRGPEvent: context.notifyCommittedRGPEvent };
    if (name === "../../utils/retryableDatabaseError") return { retryableDatabaseResponse: () => null };
    if (name === "../../utils/dateFormatter") return { formatDate: value => value };
    if (name === "../../utils/pdfHelper") return {};
    if (name === "../../AzurConfigration/Gatepass/AzureGetData") return () => "test-url";
    if (name === "pdfmake") return function PdfPrinter() {};
    if (name === "path") return path;
    throw new Error(`Unexpected Gatepass dependency: ${name}`);
  };
  vm.runInNewContext(source, context);
  return { calls, events, deliveries, create: context.module.exports.createRGP,
    approve: context.module.exports.processRGPApproval };

}
const dataFor = (stage, Action = "APPROVE") => ({ RGPID: 42, Action,
  UserID: stage + 2, UserType: stage === 2 ? "GM" : "HOD", UserDepartmentID: 7,
  DepartmentName: stage === 1 ? "Finance" : "Operations", Remarks: "  Vendor details need correction.  " });

test("create dispatches a persisted master/approval snapshot only after commit and release", async () => {
  const h = harness();
  const result = await h.create({ OrganizationID: 20, DepartmentID: 7, UserID: 1 });
  assert.equal(result.success, true);
  assert.equal(h.events.length, 1);
  assert.equal(h.events[0].master.rgpnumber, 1007);
  assert.equal(h.events[0].master.createdby, 1);
  assert.deepEqual(h.events[0].approvals.map(row => row.approvalrole), ["HOD", "FC", "GM"]);
  await Promise.all(h.deliveries);
});

test("creation snapshots custom organization configuration rather than default roles", async () => {
  const h = harness({ customFlow: [{ rgpapprovalconfigid: 70, approvallevel: 2,
    approvalorder: 1, approvalrole: "GM", ismandatory: true }] });
  await h.create({ OrganizationID: 20, DepartmentID: 7, UserID: 1 });
  assert.deepEqual(h.events[0].approvals.map(row => row.approvalrole), ["GM"]);
  await Promise.all(h.deliveries);
});

for (const stage of [0, 1, 2]) {
  for (const action of ["APPROVE", "REJECT", "CANCEL"]) {
    test(`${stages(0)[stage].approvalrole} ${action} commits stage and master before notification`, async () => {
      const h = harness({ stage });
      const result = await h.approve(dataFor(stage, action));
      assert.equal(result.success, true);
      const expectedMaster = action === "APPROVE" ? (stage === 2 ? "APPROVED" : "PENDING") :
        action === "REJECT" ? "REJECTED" : "CANCELLED";
      assert.equal(result.data.Status, expectedMaster);
      const update = h.calls.find(({ sql }) => /UPDATE Gatepass_RGP_Approval\s/.test(sql));
      assert.equal(update.params[0], { APPROVE: "Approved", REJECT: "Rejected", CANCEL: "Cancelled" }[action]);
      assert.equal(update.params[1], stage + 2);
      assert.equal(update.params[2], "Vendor details need correction.");
      assert.equal(h.events.length, 1);
      assert.equal(h.events[0].approvalID, 101 + stage);
      assert.equal(h.events[0].master.createdby, 1);
      assert.equal(h.events[0].action, action);
      if (action !== "APPROVE") {
        const masterUpdate = h.calls.find(({ sql }) => /UPDATE Gatepass_RGP_Entry_Master/.test(sql));
        assert.match(masterUpdate.sql, new RegExp(`Status = '${expectedMaster}'`));
        if (action === "CANCEL") {
          assert.deepEqual(masterUpdate.params, [stage + 2, "Vendor details need correction.", 42]);
          assert.match(masterUpdate.sql, /CancelledBy = \$1/);
          assert.match(masterUpdate.sql, /CancelledDateTime =\s*CURRENT_TIMESTAMP/);
          assert.match(masterUpdate.sql, /CancellationRemarks = \$2/);
        }
      }
      assert.ok(!h.calls.some(({ sql }) => sql === "ROLLBACK"));
      await Promise.all(h.deliveries);
    });
  }
}

test("failed writes and commits never dispatch for creation or approvals", async () => {
  for (const failure of [{ commitFailure: true }, { writeFailure: true }]) {
    for (const method of ["create", "approve"]) {
      const h = harness(failure);
      const result = await h[method](method === "create" ? { OrganizationID: 20 } : dataFor(0));
      assert.equal(result.success, false);
      assert.equal(h.events.length, 0);
      assert.ok(h.calls.some(({ sql }) => sql === "ROLLBACK"));
    }
  }
});

test("invalid actions, missing remarks, wrong department and wrong stage cannot notify", async () => {
  for (const changes of [
    { Action: "UNKNOWN" }, { Action: "CANCEL", Remarks: "  " }, { Action: "REJECT", Remarks: null },
    { UserDepartmentID: 99 }, { UserType: "GM" },
  ]) {
    const h = harness();
    const result = await h.approve({ ...dataFor(0), ...changes });
    assert.equal(result.success, false);
    assert.equal(h.events.length, 0);
    assert.ok(!h.calls.some(({ sql }) => /UPDATE Gatepass/.test(sql)));
  }
});

test("terminal and repeated actions neither mutate nor notify", async () => {
  for (const status of ["CANCELLED", "REJECTED", "APPROVED", "CHECKED OUT", "RETURNED"]) {
    const h = harness({ masterOverrides: { status } });
    assert.equal((await h.approve(dataFor(0, "CANCEL"))).success, false);
    assert.equal(h.events.length, 0);
    assert.ok(!h.calls.some(({ sql }) => /UPDATE Gatepass/.test(sql)));
  }
  const h = harness({ stage: 1 });
  assert.equal((await h.approve(dataFor(0))).success, false);
  assert.equal(h.events.length, 0);
});

test("notification failure never rolls back or fails a committed gatepass operation", async () => {
  for (const method of ["create", "approve"]) {
    const h = harness({ notificationFailure: true });
    const result = await h[method](method === "create" ? { OrganizationID: 20 } : dataFor(0, "CANCEL"));
    assert.equal(result.success, true);
    const [delivery] = await Promise.all(h.deliveries);
    assert.equal(delivery.failed, true);
    assert.ok(!h.calls.some(({ sql }) => sql === "ROLLBACK"));
  }
});

test("persisted DOF next stage dispatches after HOD commit; Finance aliases authorize consistently", async () => {
  const hod = harness({ financeRole: "DOF" });
  assert.equal((await hod.approve(dataFor(0))).success, true);
  assert.equal(hod.events[0].approvals[1].approvalrole, "DOF");
  assert.equal((await Promise.all(hod.deliveries))[0].skipped, false);
  for (const financeRole of ["DOF", "FINANCE", "FC"]) {
    const finance = harness({ stage: 1, financeRole });
    assert.equal((await finance.approve(dataFor(1))).success, true);
    assert.equal((await Promise.all(finance.deliveries))[0].skipped, false);
  }
});

test("approval controller accepts normalized cancellation and requires remarks", async () => {
  const controller = fs.readFileSync(path.join(__dirname,
    "../../controllers/GatepassController/GatepassController.js"), "utf8");
  const sent = [];
  const context = { exports: {}, STATUS_CODES: { BAD_REQUEST: 400 }, AppError: Error,
    sendQueueResponse: async (_req, _res, action, data) => { sent.push({ action, data }); return { success: true }; },
    handleError: error => ({ success: false, message: error.message }),
  };
  vm.runInNewContext(controller.slice(controller.indexOf("exports.processRGPApproval ="),
    controller.indexOf("exports.processRGPGateAction =")), context);
  assert.equal((await context.exports.processRGPApproval({ body: {
    RGPID: 42, Action: " cancel ", Remarks: "  Incorrect vendor.  " } }, {})).success, true);
  assert.deepEqual(plain(sent[0]), { action: "PROCESS_RGP_APPROVAL", data: {
    RGPID: 42, Action: "CANCEL", Remarks: "Incorrect vendor." } });
  const invalid = await context.exports.processRGPApproval({ body: { RGPID: 42, Action: "CANCEL" } }, {});
  assert.equal(invalid.success, false);
  assert.match(invalid.message, /Remarks are required for CANCEL/);
  assert.equal(sent.length, 1);
});
