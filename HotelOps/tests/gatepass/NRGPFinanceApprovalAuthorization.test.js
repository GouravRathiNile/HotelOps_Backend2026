const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../../services/GatepassService/GatepassService.js'), 'utf8').replace(/\r\n/g, '\n');

async function authorize({ departmentName = 'Finance', approvalType = 'FC', firstStatus = 'Approved', actionBy = 8, userID = 6 } = {}) {
  const stages = [
    { approvalorder: 1, status: firstStatus, actionby: actionBy, approvalrole: 'HOD', approvaltype: 'HOD', approvertype: 'ROLE' },
    { approvalorder: 2, status: 'Pending', approvalrole: 'HOD', approvaltype: approvalType, approvertype: 'ROLE' },
  ];
  const context = {
    fail: (message, statusCode) => ({ success: false, message, statusCode }),
    pool: { connect: async () => ({ query: async sql => {
      if (sql.includes('FROM Gatepass_NRGP_Entry_Master')) return { rows: [{ status: 'PENDING', departmentid: 1032 }] };
      if (sql.includes('FROM Gatepass_NRGP_Approval')) {
        assert.match(sql, /detail.ApprovalType/);
        assert.match(sql, /detail.ApprovalID = Gatepass_NRGP_Approval.ApprovalMasterDetailID/);
        return { rows: stages };
      }
      return { rows: [] };
    } }) },
  };
  vm.createContext(context);
  for (const name of ['normalizeNRGPApprovalRole', 'getNRGPUserApprovalRole']) {
    const start = source.indexOf('const ' + name + ' =');
    vm.runInContext(source.slice(start, source.indexOf('\n};', start) + 3), context);
  }
  const start = source.indexOf('const processNRGPApproval =');
  const end = source.indexOf('    // ============================================================\n    // Notification Snapshot', start);
  vm.runInContext(source.slice(start, end) + '\nreturn { success: true }; } catch (error) { throw error; } }; this.run = processNRGPApproval;', context);
  return context.run({ NRGPID: 7, UserID: userID, UserType: 'HOD', DepartmentName: departmentName, UserDepartmentID: 1031, Action: 'APPROVE' });
}

test('Finance HOD can authorize configured HOD finance stages', async () => {
  for (const approvalType of ['FC', 'DOF']) assert.equal((await authorize({ approvalType })).success, true);
});

test('Other departments and ordinary HOD stages remain restricted', async () => {
  for (const input of [{ departmentName: 'Operations' }, { approvalType: 'HOD' }]) {
    const result = await authorize(input);
    assert.equal(result.success, false);
    assert.equal(result.statusCode, 403);
  }
});

test('Approval sequencing and duplicate approval checks remain enforced', async () => {
  for (const input of [{ firstStatus: 'Pending' }, { actionBy: 6 }]) {
    const result = await authorize(input);
    assert.equal(result.success, false);
    assert.equal(result.statusCode, 403);
  }
});
