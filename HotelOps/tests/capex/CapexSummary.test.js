const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { pool } = require("../../db");
const CapexService = require("../../services/CapexService/CapexService");

test("CAPEX notifications use organization-scoped configured-role recipients", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const source = fs.readFileSync(path.join(__dirname, "../../services/CapexService/CapexService.js"), "utf8");
  const resolver = source.match(/const resolveCapexNotificationRecipients[\s\S]*?const notifyCapex/)?.[0] || "";
  assert.match(resolver, /SELECT DISTINCT um\.userid/);
  assert.match(resolver, /SELECT 1 FROM user_org_mapping uom/);
  assert.match(resolver, /uom\.organizationid = \$1/);
  assert.match(resolver, /CapexWorkflow\.regionalAccessSQL/);
  assert.match(resolver, /dm.departmentid = um.departmentid/);
  assert.match(resolver, /dm.organizationid = cm.organizationid/);
  assert.match(resolver, /UPPER\(TRIM\(dm.departmentname\)\) = UPPER\(TRIM\(cm.department\)\)/);
  assert.match(resolver, /UPPER\(TRIM\(um\.usertype\)\) = ANY\(\$2::text\[\]\)/);
  assert.match(resolver, /um\.userid::text = ANY\(\$3::text\[\]\)/);
  assert.match(resolver, /um\.userid::text <> \$4::text/);
  assert.match(resolver, /userIds: notificationUserIds\(result\.rows\.map/);
});

test("CAPEX create and approval notifications follow configured stages and recipient rules", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const source = fs.readFileSync(path.join(__dirname, "../../services/CapexService/CapexService.js"), "utf8");
  const createBlock = source.slice(source.indexOf("const createCapex ="), source.indexOf("const getAllCapex ="));
  const approvalBlock = source.match(/const processCapexApproval = async[\s\S]*?\/\/ =+ Summary/)?.[0] || source.match(/const processCapexApproval = async[\s\S]*?const getCapexSummaryReport/)?.[0] || "";
  assert.match(createBlock, /CapexWorkflow\.snapshot/);
  assert.match(createBlock, /roles: firstApprovalRole \? \[firstApprovalRole\] : \[\]/);
  assert.match(approvalBlock, /roles: \[followingStage\.role\]/);
  assert.match(approvalBlock, /kind: "APPROVE"[\s\S]*includeCreator: true/);
  for (const kind of ["REJECT", "RETURN", "HOLD"]) {
    const event = approvalBlock.slice(approvalBlock.indexOf(`kind: "${kind}"`));
    const config = event.slice(0, event.indexOf("});"));
    assert.match(config, /includeCreator: true/);
    assert.doesNotMatch(config, /roles:|excludeActor:/);
  }
});

test("CAPEX notification payloads are canonical and never include CAPEX number", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const source = fs.readFileSync(path.join(__dirname, "../../services/CapexService/CapexService.js"), "utf8");
  const notifier = source.match(/const notifyCapex[\s\S]*?const notifyCommittedCapex/)?.[0] || "";
  assert.match(source, /const CAPEX_NOTIFICATION_MODULE = "Capex"/);
  assert.match(notifier, /moduleName: CAPEX_NOTIFICATION_MODULE/);
  assert.match(notifier, /entityType: "Capex"/);
  assert.match(notifier, /type: "info"/);
  assert.match(notifier, /priority: "normal"/);
  assert.match(source, /action: "CREATED"/);
  for (const action of ["APPROVED", "REJECTED", "RETURNED", "HOLD"]) assert.match(source, new RegExp(`notificationAction: "${action}"`));
  const notificationContent = source.match(/const firstApprovalRole[\s\S]*?return \{\s*success: true,\s*message: "CAPEX created/)?.[0] || "";
  assert.doesNotMatch(notificationContent, /CapexNumber|capexNumber/);
  assert.doesNotMatch(notifier, /data\.moduleName|req\.body/);
});

test("CAPEX notification text is consistent across actions and handles missing values", () => {
  const vm = require("node:vm");
  const source = fs.readFileSync(path.join(__dirname, "../../services/CapexService/CapexService.js"), "utf8");
  const content = source.slice(source.indexOf("const capexNotificationContent ="), source.indexOf("// CAPEX owns its recipient"));
  const context = { module: { exports: {} } };
  vm.runInNewContext(content + "\nmodule.exports = capexNotificationContent;", context);
  const format = context.module.exports;
  const values = { item: " Pump ", qty: 2, department: " Engineering ", organizationShortName: " TEST ", actorName: " Alex " };
  const expected = [
    ["CREATE", false, "A new Capex request has been created and is awaiting your review."],
    ["APPROVE", false, "The Capex request has been approved by Alex and is awaiting your review."],
    ["APPROVE", true, "Your Capex request has been fully approved by Alex."],
    ["AUTO_APPROVED", false, "Your Capex request has been fully approved by Alex."],
    ["REJECT", false, "The Capex request has been rejected by Alex."],
    ["RETURN", false, "The Capex request has been returned by Alex for revision."],
    ["HOLD", false, "The Capex request has been put on hold by Alex."],
  ];
  for (const [kind, isFinalApproval, message] of expected) {
    const result = format({ ...values, kind, isFinalApproval });
    assert.equal(result.title, "Capex - Pump (2) - Engineering - TEST");
    assert.equal(result.message, message);
  }
  assert.equal(format({ kind: "CREATE" }).title, "Capex - - (-) - - - -");
  assert.equal(format({ ...values, qty: 0 }).title, "Capex - Pump (0) - Engineering - TEST");
  assert.equal(format({ ...values, qty: "120.00" }).title, "Capex - Pump (120) - Engineering - TEST");
  assert.equal(format({ ...values, qty: "1.50" }).title, "Capex - Pump (1.5) - Engineering - TEST");
  assert.equal(format({ ...values, qty: "1.25" }).title, "Capex - Pump (1.25) - Engineering - TEST");
  assert.equal(format({ kind: "REJECT", actorName: " ", approverRole: " GM " }).message,
    "The Capex request has been rejected by GM.");
  assert.equal(format({ kind: "AUTO_APPROVED" }).message, "Your Capex request has been fully approved by System.");
  assert.match(source, /isFinalApproval: change.action === "APPROVE" && !next/);
  assert.match(source, /kind: "APPROVE",\s*isFinalApproval: true,\s*notificationAction: "APPROVED"/);
});

test("CAPEX notifications are triggered only after commit and failures are isolated", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const source = fs.readFileSync(path.join(__dirname, "../../services/CapexService/CapexService.js"), "utf8");
  assert.match(source, /const notifyCommittedCapex = \(event\)[\s\S]*Promise\.resolve\(\)[\s\S]*notifyCapex\(event\)[\s\S]*\.catch\(/);
  assert.match(source, /await client\.query\("COMMIT"\);\s*transactionStarted = false;\s*const firstStep[\s\S]*const firstApprovalRole[\s\S]*notifyCommittedCapex\(/);
  for (const kind of ["REJECT", "RETURN", "HOLD"]) {
    assert.match(source, new RegExp(`await client\\.query\\("COMMIT"\\);[\\s\\S]{0,180}notifyApprovalCommitted\\(\\{[\\s\\S]{0,80}kind: "${kind}"`));
  }
  assert.equal((source.match(/await client\.query\("COMMIT"\);\s*transactionStarted = false;\s*notifyApprovalCommitted\(\{\s*kind: "APPROVE"/g) || []).length, 2);
});

test("CAPEX update preserves existing documents and inserts only new uploads", { concurrency: false }, async () => {
  const originalConnect = pool.connect;
  const calls = [];
  const client = {
    query: async (sql, values) => {
      calls.push({ sql, values });
      if (/SELECT cm.organizationid, cm.createdby/.test(sql)) return { rows: [{ organizationid: 20, createdby: 8, hasaction: false }] };
      if (/SELECT um.userid, um.usertype/.test(sql)) return { rows: [{ userid: 8, usertype: "HOD" }] };
      if (/UPDATE Capex_Master/.test(sql)) {
        return { rows: [{ capexid: 21, capexnumber: 11 }] };
      }
      if (/FROM Capex_Documents[\s\S]*FOR UPDATE/.test(sql)) {
        return {
          rows: [
            { capexdocumentid: 17, filepath: "old-17.png" },
            { capexdocumentid: 18, filepath: "old-18.pdf" },
          ],
        };
      }
      if (/MAX\(CapexDocumentID\)/.test(sql)) {
        return { rows: [{ nextid: "19" }] };
      }
      return { rows: [] };
    },
    release: () => {},
  };
  pool.connect = async () => client;

  try {
    const response = await CapexService.updateCapex({
      CapexID: 21,
      UserID: 8,
      Changes: { Item: "Updated item" },
      Documents: [
        {
          FileName: "new.xlsx",
          FilePath: "new-19.xlsx",
          FileType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          FileSize: 100,
        },
      ],
      DeleteDocumentIDs: [],
    });

    assert.equal(response.success, true);
    assert.equal(
      calls.some((call) => /INSERT INTO Capex_Documents/.test(call.sql)),
      true,
    );
    assert.equal(
      calls.some((call) => /UPDATE Capex_Documents/.test(call.sql)),
      false,
    );
    assert.equal(calls.some((call) => call.sql === "COMMIT"), true);

    calls.length = 0;
    const noDocumentChanges = await CapexService.updateCapex({
      CapexID: 21,
      UserID: 8,
      Changes: { Description: "Text only update" },
      Documents: [],
      DeleteDocumentIDs: [],
    });
    assert.equal(noDocumentChanges.success, true);
    assert.equal(
      calls.some((call) => /FROM Capex_Documents|UPDATE Capex_Documents/.test(call.sql)),
      false,
    );
  } finally {
    pool.connect = originalConnect;
  }
});

test("CAPEX update deletes only requested owned document IDs", { concurrency: false }, async () => {
  const originalConnect = pool.connect;
  const calls = [];
  const client = {
    query: async (sql, values) => {
      calls.push({ sql, values });
      if (/SELECT cm.organizationid, cm.createdby/.test(sql)) return { rows: [{ organizationid: 20, createdby: 8, hasaction: false }] };
      if (/SELECT um.userid, um.usertype/.test(sql)) return { rows: [{ userid: 8, usertype: "HOD" }] };
      if (/UPDATE Capex_Master/.test(sql)) {
        return { rows: [{ capexid: 21, capexnumber: 11 }] };
      }
      if (/FROM Capex_Documents[\s\S]*FOR UPDATE/.test(sql)) {
        return { rows: [{ capexdocumentid: 17, filepath: "old-17.png" }] };
      }
      return { rows: [] };
    },
    release: () => {},
  };
  pool.connect = async () => client;

  try {
    const deleted = await CapexService.updateCapex({
      CapexID: 21,
      UserID: 8,
      Changes: { Item: "Updated item" },
      Documents: [],
      DeleteDocumentIDs: [17],
    });
    assert.equal(deleted.success, true);
    const deleteCall = calls.find((call) => /UPDATE Capex_Documents/.test(call.sql));
    assert.deepEqual(deleteCall.values, [8, 21, [17]]);

    calls.length = 0;
    const invalid = await CapexService.updateCapex({
      CapexID: 21,
      UserID: 8,
      Changes: { Item: "Updated again" },
      Documents: [],
      DeleteDocumentIDs: [999],
    });
    assert.equal(invalid.success, false);
    assert.equal(invalid.statusCode, 400);
    assert.match(invalid.message, /selected for deletion are invalid/);
    assert.equal(calls.some((call) => call.sql === "ROLLBACK"), true);
  } finally {
    pool.connect = originalConnect;
  }
});
