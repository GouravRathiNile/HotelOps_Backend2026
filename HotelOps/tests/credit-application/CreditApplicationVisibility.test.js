require("dotenv").config({ quiet: true });
const test = require("node:test");
const assert = require("node:assert/strict");
const { pool } = require("../../db");
const { getCreditApplicationList } = require("../../services/CreditApplicationService/CreditApplicationService");
const { isLegacyCreditApprover } = require("../../utils/creditApplicationApprover");

const captureList = async (context, isApprover = false) => {
  const original = pool.query;
  const calls = [];
  pool.query = async (sql, values) => {
    calls.push({ sql, values });
    if (/AS IsApprover/i.test(sql)) return { rows: [{ isapprover: isApprover }] };
    if (/COUNT\(\*\)::bigint/i.test(sql)) return { rows: [{ totalcount: "0" }] };
    return { rows: [] };
  };
  try {
    const response = await getCreditApplicationList({ OrganizationID: 1401, page: 1, PageSize: 10, ...context });
    assert.equal(response.success, true, response.message);
    return { calls: calls.filter(({ sql }) => !/AS IsApprover/i.test(sql)), response };
  } finally { pool.query = original; }
};

test("CEO pending list runs with imported helpers, scopes organization and honors status", async () => {
  // A CEO who is also assigned a stage still needs the full organization view.
  const { calls, response } = await captureList({ UserType: "CEO", Status: "Pending" }, true);
  assert.equal(calls.length, 2);
  assert.equal(response.data.CanFilter, true);
  for (const call of calls) {
    assert.match(call.sql, /ca\.OrganizationID = \$1/);
    assert.match(call.sql, /ca\.IsDeleted = FALSE/);
    assert.doesNotMatch(call.sql.slice(call.sql.indexOf("WHERE ca.IsDeleted")), /ca\.ARID/);
    assert.doesNotMatch(call.sql, /caa_history/);
    assert.deepEqual(call.values.slice(0, 2), [1401, "PENDING"]);
  }
});

test("CEO unfiltered list includes applications without requiring ARID", async () => {
  const { calls } = await captureList({ UserType: " ceo " });
  assert.doesNotMatch(calls[0].sql, /ca\.ARID/);
  assert.deepEqual(calls[0].values, [1401]);
});

test("other non-approvers retain completed application visibility", async () => {
  const { calls } = await captureList({ UserType: "HOD", DepartmentName: "Engineering" });
  assert.match(calls[0].sql, /ca\.ARID/);
  assert.match(calls[0].sql, /IS NOT NULL/);
});

test("Finance list resolves legacy assignment SQL without missing helper errors", async () => {
  const { calls } = await captureList({ UserType: "HOD", DepartmentName: "Finance", Status: "Pending" }, true);
  assert.match(calls[0].sql, /caa_history\.ApproverType/);
  assert.match(calls[0].sql, /caa_history\.ApproverValue/);
});

test("legacy fallback does not grant approval to CEO or override explicit users", () => {
  const fc = { ApprovalRole: "FC", ApproverType: null, ApproverValue: "FC" };
  assert.equal(isLegacyCreditApprover(fc, { DepartmentName: "Finance" }), true);
  assert.equal(isLegacyCreditApprover(fc, { UserType: "CEO" }), false);
  assert.equal(isLegacyCreditApprover({ ...fc, ApproverType: "USER" }, { DepartmentName: "Finance" }), false);
  const gm = { ApprovalRole: "GM", ApproverType: null, ApproverValue: "GM" };
  assert.equal(isLegacyCreditApprover(gm, { UserType: "GM" }), true);
  assert.equal(isLegacyCreditApprover(gm, { UserType: "CEO" }), false);
});
