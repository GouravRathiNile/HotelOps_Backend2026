const { normalizeRGPApprovalRole } = require("../../services/GatepassService/RGPApprovalRoles");
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../../services/GatepassService/GatepassService.js'), 'utf8');

async function list({ status = 'PENDING', flow = [], user = {}, empty = false, expectedFailure = false }) {
  let calls = 0;
  const context = {
    normalizeRGPApprovalRole, console, formatDate: value => value,
    pool: { query: async (sql, values) => {
      calls++;
      sql = sql.replace(/\s+/g, ' ');
      if (sql.includes('AS TotalCount')) return { rows: [{ totalcount: empty ? 0 : 1 }] };
      if (sql.includes('FROM Gatepass_RGP_Approval a') && !sql.includes('FROM Gatepass_RGP_Entry_Master')) {
        assert.deepEqual(Array.from(values[0]), [1]);
        assert.match(sql, /IsDeleted = FALSE/);
        assert.match(sql, /ORDER BY a.RGPID ASC, a.ApprovalOrder ASC, a.RGPApprovalID ASC/);
        return { rows: flow.map(row => ({ rgpid: 1, ...row })) };
      }
      if (sql.includes('FROM approval_master am')) return { rows: flow.map((row, i) => ({
        approvalid: i+1, level: i+1, approvertype: row.approvertype || 'ROLE',
        role: row.approvalrole, approvaltype: row.approvaltype || row.approvalrole })) };
      return { rows: empty ? [] : [{ rgpid: 1, departmentid: 7, status }] };
    } },
    retryableDatabaseResponse: error => { throw error; },
  };
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('const ok ='), source.indexOf('const mapRGPItem =')) +
    source.slice(source.indexOf('const mapRGPApproval ='), source.indexOf('const attachRGPRelatedData =')) +
    source.slice(source.indexOf('const getRGPList ='), source.indexOf('const getRGPById =')) +
    '\nthis.run = getRGPList;', context);
  const result = await context.run({ OrganizationID: 1, UserID: 9, UserType: 'HOD', UserDepartmentID: 7, ...user });
  if (expectedFailure) {
    assert.equal(result.success, false);
    assert.equal(result.statusCode, 400);
    assert.match(result.message, /User DepartmentID is required for HOD/);
    assert.equal(calls, 0);
    return [];
  }
  assert.equal(result.success, true);
  assert.equal(calls, empty ? 2 : 4);
  return result.data;
}

test('RGP approval flags follow current stage and logged-in approver', async () => {
  const pending = { approvalrole: 'HOD', status: 'Pending' };
  const approved = { ...pending, status: 'Approved', actionby: 9 };
  for (const scenario of [
    { flow: [pending], expected: true },
    { flow: [pending], user: { UserDepartmentID: 8 }, expected: false },
    { flow: [pending], user: { UserType: 'GM' }, expected: false },
    { flow: [approved, { approvalrole: 'FC', status: 'Pending' }], expected: false },
    { flow: [approved, pending], expected: false },
    { flow: [{ ...approved, actionby: 8 }, { approvalrole: 'FC', status: 'Pending' }], user: { DepartmentName: ' finance ' }, expected: true },
    { flow: [{ approvalrole: 'CEO', status: 'Pending' }], user: { UserType: 'CEO' }, expected: true },
    { flow: [approved], expected: false },
    { flow: [], expected: false },
    ...['APPROVED', 'REJECTED', 'CHECKED OUT', 'CANCELLED', 'RETURN PENDING', 'RETURNED'].map(status => ({ status, flow: [pending], expected: false })),
  ]) {
    const [row] = await list(scenario);
    assert.equal(row.canappprove, scenario.expected, JSON.stringify(scenario));
    assert.equal(row.cancheckout, false);
  }
});

test('RGP checkout flag requires Security and completed approvals before gate action', async () => {
  for (const status of ['PENDING', 'APPROVED', 'CHECKED OUT', 'CANCELLED', 'RETURN PENDING', 'RETURNED', 'REJECTED']) {
    const [row] = await list({ status, flow: [{ approvalrole: 'GM', status: 'Approved' }], user: { DepartmentName: ' security ' } });
    assert.equal(row.cancheckout, status === 'APPROVED');
  }
  for (const scenario of [
    { flow: [] },
    { flow: [{ approvalrole: 'GM', status: 'Pending' }] },
    { flow: [{ approvalrole: 'GM', status: 'Approved' }], user: { DepartmentName: 'Finance' } },
  ]) {
    const [row] = await list({ status: 'APPROVED', user: { DepartmentName: 'Security' }, ...scenario });
    assert.equal(row.cancheckout, false);
  }
  assert.equal((await list({ empty: true })).length, 0);
});

test("HOD without department cannot approve a department stage", async () => {
  const [row] = await list({ flow: [{ approvalrole: 'HOD', status: 'Pending' }], user: { UserDepartmentID: undefined } });
  assert.equal(row.canappprove, false);
});

test('Finance HOD can see actionable builder FC after Engineering HOD approval', async () => {
  const flow = [
    { approvalrole: 'HOD', approvaltype: 'HOD', status: 'Approved', actionby: 8 },
    { approvalrole: 'HOD', approvaltype: 'FC', status: 'Pending' },
    { approvalrole: 'GM', approvaltype: 'GM', status: 'Pending' },
  ];
  const [finance] = await list({ flow, user: { DepartmentName: 'Finance', UserDepartmentID: 99 } });
  assert.equal(finance.canappprove, true);
  assert.equal(finance.Approvals[1].Status, 'Pending');
  const [engineering] = await list({ flow });
  assert.equal(engineering.canappprove, false);
});

for (const kind of ['RGP', 'NRGP']) {
 test(kind + ' edit is blocked after first approval even while master is Pending', async () => {
  for (const firstStatus of ['Pending', 'Approved']) {
   const calls = [];
   let released = false;
   const context = { fail: (message, statusCode) => ({ success: false, message, statusCode }),
    pool: { connect: async () => ({ release: () => { released = true; }, query: async (sql) => {
     calls.push(sql);
     if (sql.includes('FROM Gatepass_' + kind + '_Entry_Master')) {
      assert.match(sql, /FOR UPDATE/);
      return { rows: [{ status: 'PENDING' }] };
     }
     if (sql.includes('FROM Gatepass_' + kind + '_Approval')) return { rows: [{ status: firstStatus }] };
     return { rows: [] };
    } }) } };
   vm.createContext(context);
   const start = source.indexOf('const update' + kind + ' =');
   const end = source.indexOf('    // Update Master', start);
   vm.runInContext(source.slice(start, end) +
    '\nreturn { success: true }; } finally { client.release(); } }; this.run = update' + kind + ';', context);
   const result = await context.run({ [kind + 'ID']: 1, OrganizationID: 1, DepartmentID: 7, VendorName: 'Vendor' });
   assert.equal(result.success, firstStatus === 'Pending');
   if (firstStatus === 'Approved') {
    assert.equal(result.statusCode, 400);
    assert.match(result.message, /cannot be edited after the first approval/);
    assert.ok(calls.includes('ROLLBACK'));
   }
   assert.ok(!calls.some(sql => /UPDATE |INSERT |DELETE /i.test(sql)));
   assert.equal(released, true);
  }
 });
}
