const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../../services/GatepassService/GatepassService.js'), 'utf8');

async function list({ status = 'PENDING', flow = [], user = {}, empty = false }) {
  let calls = 0;
  const context = {
    console, formatDate: value => value,
    pool: { query: async (sql, values) => {
      calls++;
      if (sql.includes('AS TotalCount')) return { rows: [{ totalcount: empty ? 0 : 1 }] };
      if (sql.includes('FROM Gatepass_RGP_Approval')) {
        assert.deepEqual(Array.from(values[0]), [1]);
        assert.match(sql, /IsDeleted = FALSE/);
        assert.match(sql, /ORDER BY ApprovalOrder ASC, ApprovalLevel ASC, RGPApprovalID ASC/);
        return { rows: flow.map(row => ({ rgpid: 1, ...row })) };
      }
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
  assert.equal(result.success, true);
  assert.equal(calls, empty ? 2 : 3);
  return result.data;
}

test('RGP approval flags follow current stage and logged-in approver', async () => {
  const pending = { approvalrole: 'HOD', status: 'Pending' };
  const approved = { ...pending, status: 'Approved', actionby: 9 };
  for (const scenario of [
    { flow: [pending], expected: true },
    { flow: [pending], user: { UserDepartmentID: 8 }, expected: false },
    { flow: [pending], user: { UserDepartmentID: undefined }, expected: false },
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
