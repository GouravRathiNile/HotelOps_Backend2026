const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../../services/GatepassService/GatepassService.js'), 'utf8');

test('RGP report separates approval and lifecycle statuses', async () => {
  const scenarios = [
    ['PENDING', null, 'Pending from GM since 5 day(s)', 'Open', 'GM', 5],
    ['PENDING', null, 'Pending from HOD since 0 day(s)', 'Open', 'HOD', 0],
    ['PENDING', null, 'Pending', 'Open'],
    ['APPROVED', null, 'Approved', 'Open'],
    ['CHECKED OUT', '2999-01-01', 'Approved', 'Checkout'],
    ['RETURN PENDING', '2000-01-01', 'Approved', 'Partial Return'],
    ['CHECKED OUT', '2000-01-01', 'Approved', 'Overdue'],
    ['RETURNED', '2000-01-01', 'Approved', 'Returned'],
    ['REJECTED', null, 'Rejected', 'Rejected'],
    ['CANCELLED', null, 'Cancelled', 'Cancelled'],
    [' pending ', null, 'Pending', 'Open'],
  ];
  const rows = scenarios.map(([status, expectedreturndate, , , pendingapprovalrole, pendingapprovaldays], index) => ({ rgpid: index + 1, status, expectedreturndate, pendingapprovalrole, pendingapprovaldays, modifieddate: index === 0 ? null : "2026-10-07" }));
  const context = {
    formatDate: value => value,
    attachRGPRelatedData: async records => records.map(() => ({ Items: [], Approvals: [] })),
    ok: (message, data, pagination) => ({ success: true, data, ...pagination }),
    databaseFailure: error => { throw error; },
    pool: { query: async sql => {
      if (!sql.includes('AS TotalCount')) {
        assert.match(sql, /m\.ModifiedDate/);
        assert.match(sql, /LEFT JOIN LATERAL/);
        assert.match(sql, /ORDER BY a.ApprovalOrder ASC, a.ApprovalLevel ASC, a.RGPApprovalID ASC/);
        assert.match(sql, /previousApproval.ApprovalOrder < pendingApproval.ApprovalOrder/);
        assert.match(sql, /MAX\(previousApproval.StatusDateTime\)::DATE/);
        assert.match(sql, /m.CreatedDate::DATE/);
      }
      return { rows: sql.includes('AS TotalCount') ? [{ totalcount: rows.length }] : rows };
    } },
  };
  vm.createContext(context);
  const start = source.indexOf('const getRGPListReport =');
  const end = source.indexOf('\n};', start) + 3;
  vm.runInContext(source.slice(start, end) + '\nthis.run = getRGPListReport;', context);
  const result = await context.run({ OrganizationID: 1 });
  assert.equal(result.success, true);
  result.data.forEach((row, index) => {
    assert.equal(row.modifieddate, index === 0 ? null : '2026-10-07');
    assert.equal(row.ApprovalStatus, scenarios[index][2]);
    assert.equal(row.RGPStatus, scenarios[index][3]);
    assert.ok(Array.isArray(row.Items));
    assert.ok(Array.isArray(row.Approvals));
    assert.equal(row.status, row.RGPStatus === 'Overdue' ? 'OVERDUE' : scenarios[index][0]);
    assert.equal('pendingapprovalrole' in row, false);
    assert.equal('pendingapprovaldays' in row, false);
  });
});
