const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../../services/GatepassService/GatepassService.js'), 'utf8');

test('PDF renders split statuses, pending duration and modified date on parent item row', async () => {
  const scenarios = [
    ['PENDING', null, 'Pending from GM since 5 day(s)', 'Open'],
    ['APPROVED', null, 'Approved', 'Open'],
    ['CHECKED OUT', '2999-01-01', 'Approved', 'Checkout'],
    ['RETURN PENDING', null, 'Approved', 'Return Pending'],
    ['CHECKED OUT', '2000-01-01', 'Approved', 'Overdue'],
    ['RETURNED', null, 'Approved', 'Returned'],
    ['REJECTED', null, 'Rejected', 'Rejected'],
    ['CANCELLED', null, 'Cancelled', 'Cancelled'],
  ];
  const rows = scenarios.map(([status, expectedreturndate], index) => ({ rgpid: index + 1, rgpnumber: index + 1, status, expectedreturndate, pendingapprovalrole: 'GM', pendingapprovaldays: 5, modifieddate: '2026-10-07', lastapprovalremarks: index === 1 ? null : index === 2 ? '  ' : ' Verified by approver ' }));
  let output;
  const context = {
    formatDate: value => value,
    getRGPReportOrganizationName: async () => 'Hotel',
    attachRGPRelatedData: async records => records.map(() => ({ Items: [{ ItemName: 'One' }, { ItemName: 'Two' }], Approvals: [] })),
    generatePdf: async options => { output = options; return Buffer.from('pdf'); },
    console,
    databaseFailure: error => { throw error; },
    pool: { query: async sql => {
      assert.match(sql, /m.ModifiedDate/);
      assert.match(sql, /lastApproval.Remarks AS LastApprovalRemarks/);
      assert.match(sql, /ORDER BY a.StatusDateTime DESC NULLS LAST/);
      assert.ok(sql.includes("IN ('APPROVED', 'REJECTED', 'CANCELLED')"));
      assert.match(sql, /LEFT JOIN LATERAL/);
      assert.match(sql, /previousApproval.ApprovalOrder < pendingApproval.ApprovalOrder/);
      return { rows };
    } },
  };
  vm.createContext(context);
  const start = source.indexOf('const getRGPListReportPdf =');
  const end = source.indexOf('\n};', start) + 3;
  vm.runInContext(source.slice(start, end) + '\nthis.run = getRGPListReportPdf;', context);
  assert.equal((await context.run({ OrganizationID: 1 })).success, true);
  for (const key of ['ApprovalStatus', 'RGPStatus', 'ModifiedOn']) assert.ok(output.columns.some(column => column.key === key));
  scenarios.forEach((scenario, index) => {
    assert.equal(output.rows[index * 2].ApprovalStatus, scenario[2] + ([1, 2].includes(index) ? '' : '\nRemarks: Verified by approver'));
    assert.equal(output.rows[index * 2].RGPStatus, scenario[3]);
    assert.equal(output.rows[index * 2].ModifiedOn, '2026-10-07');
    for (const key of ['ApprovalStatus', 'RGPStatus', 'ModifiedOn']) assert.equal(output.rows[index * 2 + 1][key], '');
  });
  assert.deepEqual(Array.from(output.columns.slice(-3), column => column.header), ['Expected Return', 'Last Updated', 'Created On']);
  assert.equal(output.rows.length, 16);
});
