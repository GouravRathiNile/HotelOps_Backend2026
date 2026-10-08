const { normalizeRGPApprovalRole } = require("../../services/GatepassService/RGPApprovalRoles");
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname,
  "../../services/GatepassService/GatepassNotificationService.js"), "utf8");
const logs = [];
const context = { module: { exports: {} }, require: () => ({ pool: {}, normalizeRGPApprovalRole }),
  console: { warn: (...args) => logs.push(args), error: (...args) => logs.push(args) } };
vm.runInNewContext(source, context);
const { notifyRGPEvent, notifyCommittedRGPEvent, resolveRGPEvent,
  buildRGPNotificationContent } = context.module.exports;
const plain = (value) => JSON.parse(JSON.stringify(value));

const master = { rgpid: "42", rgpnumber: "1007", organizationid: "20", departmentid: "7", createdby: "1" };
const stages = ["HOD", "FC", "GM"].map((approvalrole, index) => ({
  rgpapprovalid: String(101 + index), approvalrole, approvalorder: index + 1,
  approvallevel: index + 1, status: "Pending", actionby: null,
}));
const eventFor = (action, stage = 0) => ({ master: { ...master }, action,
  approvalID: action === "CREATE" ? undefined : stages[stage].rgpapprovalid,
  remarks: "  Vendor details need correction.  ",
  approvals: stages.map((row, index) => ({ ...row,
    status: index < stage ? "Approved" : "Pending", actionby: index < stage ? String(index + 2) : null })) });

// Assert the SQL boundary as well as its parameters: recipient filtering must
// apply equally to direct historical actors and role-based recipients.
const recipientDb = (captured, rows) => ({ query: async (sql, params) => {
  captured.push(plain(params));
  assert.match(sql, /uom.OrganizationID = om.OrganizationID/);
  assert.match(sql, /om.OrganizationID = \$1/);
  assert.match(sql, /uom.IsActive = TRUE AND uom.IsDeleted = FALSE/);
  assert.match(sql, /um.IsActive = TRUE AND um.IsDeleted = FALSE AND um.IsLocked = FALSE/);
  assert.match(sql, /om.IsActive = TRUE AND om.ActivationStatus = TRUE AND om.IsDeleted = FALSE/);
  assert.match(sql, /um.DepartmentID = \$3 AND dm.OrganizationID = \$1 AND dm.IsDeleted = FALSE/);
  assert.match(sql, /\$2 = 'FC'[\s\S]*dm.OrganizationID = \$1 AND dm.IsDeleted = FALSE/);
  assert.match(sql, /NOT IN \('FC', 'FINANCE'\)/);
  assert.match(sql, /IN \('FC', 'FINANCE'\)/);
  assert.match(sql, /um.UserID::text = ANY\(\$4::text\[\]\)/);
  assert.match(sql, /om.ShortName/);
  assert.doesNotMatch(sql, /om.OrganizationName/);
  assert.match(sql, /item.RGPID = \$5 AND item.OrganizationID = \$1 AND item.IsDeleted = FALSE/);
  assert.match(sql, /\$2 NOT IN \('HOD', 'FC'\) AND UPPER\(TRIM\(um.UserType\)\) = \$2/);
  return { rows: rows || [{ userid: "9", shortname: "NH", rgpdepartmentname: "Engineering", itemnames: ["Pump"] }] };
} });

const cases = [
  ["CREATE", 0, "HOD", [], "A returnable gate pass for Pump from Engineering requires your approval."],
  ["APPROVE", 0, "FC", [], "The Engineering Department HOD approved the RGP. It is now awaiting Finance HOD (DOF) approval."],
  ["APPROVE", 1, "GM", [], "Finance HOD (DOF) approved the RGP. It is now awaiting GM approval."],
  ["APPROVE", 2, null, ["1"], "Your returnable gate pass has been approved. Please proceed with checkout."],
];
for (const [stage, role, previous] of [[0, "The Engineering Department HOD", []], [1, "Finance HOD (DOF)", ["2"]], [2, "GM", ["3"]]]) {
  for (const [action, verb] of [["REJECT", "rejected"], ["CANCEL", "cancelled"]]) {
    cases.push([action, stage, null, ["1", ...previous],
      `${role} ${verb} the RGP. Remarks: Vendor details need correction.`]);
  }
}
for (const [action, stage, role, directIds, message] of cases) {
  test(`${action} at ${stages[stage].approvalrole}: exact recipients and content`, async () => {
    const calls = [], sent = [];
    const result = await notifyRGPEvent(eventFor(action, stage), {
      queryable: recipientDb(calls), publishNotification: async (data) => { sent.push(data); return { success: true }; },
    });
    assert.equal(result.skipped, false);
    assert.deepEqual(calls[0], ["20", role, "7", directIds, "42"]);
    assert.equal(sent[0].title, "RGP • Engineering • Pump • NH");
    assert.equal(sent[0].message, message);
    assert.doesNotMatch(sent[0].title + sent[0].message, /1007|Nile Hotel|undefined|null/);
    assert.equal(sent[0].moduleName, "Gatepass");
    assert.equal(sent[0].entityType, "RGP");
    assert.equal(sent[0].entityId, "42");
    assert.equal(sent[0].action, action === "CREATE" ? "RGP_CREATED" : `RGP_APPROVAL_${101 + stage}_${action}`);
  });
}

test("persisted organization and department scope override irrelevant event properties", async () => {
  const calls = [];
  const event = { ...eventFor("CREATE"), OrganizationID: 999, DepartmentID: 999, UserID: 999 };
  await notifyRGPEvent(event, { queryable: recipientDb(calls, []),
    publishNotification: async () => assert.fail("No users in persisted organization") });
  assert.deepEqual(calls[0], ["20", "HOD", "7", [], "42"]);
});

test("creator/previous approver overlap and duplicate role matches yield one user ID", async () => {
  const event = eventFor("REJECT", 1);
  event.master.createdby = "2";
  const calls = [], sent = [];
  await notifyRGPEvent(event, { queryable: recipientDb(calls, [
    { userid: 2, shortname: "NH", rgpdepartmentname: "Engineering", itemnames: ["Pump"] }, { userid: "2", shortname: "NH", rgpdepartmentname: "Engineering", itemnames: ["Pump"] }]),
  publishNotification: async (data) => { sent.push(data); return { success: true }; } });
  assert.deepEqual(calls[0][3], ["2"]);
  assert.deepEqual(plain(sent[0].userIds), ["2"]);
});

test("multiple eligible HODs are notified without actor exclusion", async () => {
  const sent = [];
  await notifyRGPEvent(eventFor("CREATE"), { queryable: recipientDb([], [
    { userid: "1", shortname: "NH", rgpdepartmentname: "Engineering", itemnames: ["Pump"] }, { userid: "2", shortname: "NH", rgpdepartmentname: "Engineering", itemnames: ["Pump"] }]),
  publishNotification: async (data) => { sent.push(data); return { success: true }; } });
  assert.deepEqual(plain(sent[0].userIds), ["1", "2"]);
});

test("configured order, Finance alias and repeated roles use persisted stages", async () => {
  const event = eventFor("CREATE");
  event.approvals = [{ ...stages[2], approvalorder: 3 },
    { ...stages[1], approvalrole: " finance ", approvalorder: 1 },
    { ...stages[0], approvalorder: 2 }];
  assert.equal(resolveRGPEvent(event).recipientRole, "FC");
  const sent = [];
  await notifyRGPEvent(event, { queryable: recipientDb([]),
    publishNotification: async (data) => { sent.push(data); return { success: true }; } });
  assert.equal(sent[0].message, "A returnable gate pass for Pump from Engineering requires your approval.");
  event.action = "APPROVE";
  event.approvalID = stages[1].rgpapprovalid;
  assert.equal(resolveRGPEvent(event).recipientRole, "HOD");
  event.approvals[2].approvalrole = "FC";
  assert.equal(resolveRGPEvent(event).recipientRole, "FC");
  assert.equal(resolveRGPEvent(event).eventAction, "RGP_APPROVAL_102_APPROVE");
});

test("nonfinal GM approval follows configured next stage without checkout wording", async () => {
  const event = eventFor("APPROVE", 2);
  event.approvals.push({ rgpapprovalid: "104", approvalorder: 4, approvallevel: 4,
    approvalrole: "CEO", status: "Pending" });
  const sent = [];
  await notifyRGPEvent(event, { queryable: recipientDb([]),
    publishNotification: async (data) => { sent.push(data); return { success: true }; } });
  assert.equal(sent[0].message, "GM approved the RGP. It is now awaiting CEO approval.");
});

test("custom final approver does not generate a GM checkout instruction", async () => {
  const event = eventFor("APPROVE", 2);
  event.approvals[2].approvalrole = "CEO";
  const sent = [];
  await notifyRGPEvent(event, { queryable: recipientDb([]),
    publishNotification: async (data) => { sent.push(data); return { success: true }; } });
  assert.equal(sent[0].message, "Your returnable gate pass has been approved.");
});

test("missing historical actor retains creator; absent/inactive recipients safely skip", async () => {
  const event = eventFor("CANCEL", 2);
  event.approvals[1].actionby = null;
  assert.deepEqual(plain(resolveRGPEvent(event).directUserIds), ["1"]);
  const result = await notifyCommittedRGPEvent(event, { queryable: recipientDb([], []),
    publishNotification: async () => assert.fail("No recipient must not publish") });
  assert.equal(result.skipped, true);
  assert.ok(logs.some((args) => args.includes("no-eligible-recipient")));
});

test("lookup failure, RabbitMQ rejection, timeout and unsuccessful response are isolated", async () => {
  for (const dependencies of [
    { queryable: { query: async () => { throw new Error("database unavailable"); } } },
    ...["RabbitMQ Channel Not Initialized", "Response Timeout"].map(message => ({
      queryable: recipientDb([]), publishNotification: async () => { throw new Error(message); } })),
    { queryable: recipientDb([]), publishNotification: async () => ({ success: false, message: "insert failed" }) },
  ]) {
    assert.equal((await notifyCommittedRGPEvent(eventFor("CREATE"), dependencies)).failed, true);
  }
});

test("queued but unsaved notification response is not mistaken for persistence", async () => {
  const result = await notifyRGPEvent(eventFor("CREATE"), { queryable: recipientDb([]),
    publishNotification: async () => ({ success: true, queued: true, saved: false }) });
  assert.equal(result.queued, true);
});

test("Engineering HOD approval routes persisted DOF/FINANCE/FC stages to all Finance HODs", async () => {
  for (const alias of ["DOF", " finance ", "fc"]) {
    const event = eventFor("APPROVE", 0);
    event.approvals[1].approvalrole = alias;
    const calls = [], sent = [];
    await notifyRGPEvent(event, { queryable: recipientDb(calls, [
      { userid: "8", shortname: "NH", rgpdepartmentname: "Engineering", itemnames: ["Pump"] },
      { userid: "9", shortname: "NH", rgpdepartmentname: "Engineering", itemnames: ["Pump"] },
      { userid: "8", shortname: "NH", rgpdepartmentname: "Engineering", itemnames: ["Pump"] },
      { userid: null }, { userid: "invalid" }, { userid: "0" },
    ]), publishNotification: async (payload) => { sent.push(payload); return { success: true }; } });
    assert.equal(calls[0][1], "FC");
    assert.equal(calls[0][0], event.master.organizationid);
    assert.deepEqual(plain(sent[0].userIds), ["8", "9"]);
    assert.equal(sent[0].message,
      "The Engineering Department HOD approved the RGP. It is now awaiting Finance HOD (DOF) approval.");
  }
});

test("missing Finance recipients skip publishing after a persisted DOF transition", async () => {
  const event = eventFor("APPROVE", 0);
  event.approvals[1].approvalrole = "DOF";
  let published = false;
  const result = await notifyCommittedRGPEvent(event, { queryable: recipientDb([], []),
    publishNotification: async () => { published = true; return { success: true }; } });
  assert.equal(result.skipped, true);
  assert.equal(published, false);
});

test("multiple item names are unique, concise and identifiable", () => {
  const content = buildRGPNotificationContent({ action: "CREATE", organizationShortName: "NH",
    departmentName: "Engineering", itemNames: [" Pump ", "pump", "Motor", "Valve", null, ""] });
  assert.equal(content.title, "RGP • Engineering • Pump +2 more • NH");
  assert.equal(content.message,
    "A returnable gate pass for Pump, Motor, and 1 other item from Engineering requires your approval.");
});

test("missing display details and remarks use grammatical fallbacks without fabricated data", () => {
  const content = buildRGPNotificationContent({ action: "CREATE", itemNames: null,
    departmentName: "undefined", organizationShortName: null, organizationName: "Full Hotel Name" });
  assert.deepEqual(plain(content), { title: "RGP", message: "A returnable gate pass requires your approval." });
  const rejection = buildRGPNotificationContent({ action: "REJECT", approverRole: "HOD", remarks: null });
  assert.equal(rejection.message, "The Department HOD rejected the RGP.");
  assert.doesNotMatch(rejection.message, /Remarks|null|undefined/);
});

test("long text is bounded, whitespace normalized and Department is not repeated", () => {
  const content = buildRGPNotificationContent({ action: "CANCEL", approverRole: "HOD",
    departmentName: "Engineering Department", organizationShortName: "N".repeat(100),
    itemNames: ["A".repeat(200), "B".repeat(200)], remarks: "Needs\n  correction. ".repeat(100) });
  assert.ok(Array.from(content.title).length <= 120);
  assert.ok(Array.from(content.message).length < 450);
  assert.match(content.message, /^The Engineering Department HOD cancelled the RGP. Remarks: Needs correction/);
  assert.doesNotMatch(content.message, /Department Department|\n|  /);
  assert.match(content.message, /…$/);
});
