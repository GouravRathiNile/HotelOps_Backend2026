const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../../services/GatepassService/GatepassService.js'), 'utf8');

async function filters(data) {
  const queries = [];
  const context = {
    fail: (message, statusCode) => ({ success: false, message, statusCode }),
    databaseFailure: error => { throw error; },
    pool: { query: async (sql, values) => {
      queries.push({ sql, values: JSON.parse(JSON.stringify(values)) });
      throw new Error('query captured');
    } },
  };
  vm.createContext(context);
  const start = source.indexOf('const getRGPListReport =');
  const end = source.indexOf('\n};', start) + 3;
  vm.runInContext(source.slice(start, end) + '\nthis.run = getRGPListReport;', context);
  let result;
  try { result = await context.run({ OrganizationID: 1, ...data }); }
  catch (error) { if (error.message !== 'query captured') throw error; }
  return { result, queries };
}

test('RGP report supports inclusive date ranges and either boundary', async () => {
  for (const input of [{}, { FromDate: '2026-10-01' }, { ToDate: '2026-10-07' }, { FromDate: '2026-10-07', ToDate: '2026-10-07' }]) {
    const { queries } = await filters(input);
    assert.equal(queries.length, 1);
    assert.deepEqual(queries[0].values, [1, ...Object.values(input)]);
    if (input.FromDate) assert.match(queries[0].sql, /m.CreatedDate::DATE >= \$2::DATE/);
    if (input.ToDate) assert.match(queries[0].sql, /m.CreatedDate::DATE <= \$[23]::DATE/);
  }
});

test('RGP report rejects invalid dates and reversed ranges before querying', async () => {
  for (const input of [{ FromDate: '2026-02-30' }, { ToDate: 'invalid' }, { FromDate: ['2026-10-01'] }, { FromDate: '2026-10-08', ToDate: '2026-10-07' }]) {
    const { result, queries } = await filters(input);
    assert.equal(result.success, false);
    assert.equal(result.statusCode, 400);
    assert.equal(queries.length, 0);
  }
});

test('RGP report status filters are shared by count and paginated list queries', async () => {
  for (const [Status, expected] of [
    ['All RGP Open', "IN ('PENDING', 'APPROVED')"],
    ['All RGP Out', "= 'CHECKED OUT'"],
    ['All RGP Closed', "= 'RETURNED'"],
    ['All RGP Cancelled', "= 'CANCELLED'"],
    ['All RGP Overdue', "= 'CHECKED OUT'"],
  ]) {
    const queries = [];
    const context = {
      attachRGPRelatedData: async () => [],
      ok: (message, data) => ({ success: true, data }),
      databaseFailure: error => { throw error; },
      pool: { query: async (sql, values) => {
        queries.push({ sql, values: JSON.parse(JSON.stringify(values)) });
        return { rows: sql.includes('AS TotalCount') ? [{ totalcount: 0 }] : [] };
      } },
    };
    vm.createContext(context);
    const start = source.indexOf('const getRGPListReport =');
    const end = source.indexOf('\n};', start) + 3;
    vm.runInContext(source.slice(start, end) + '\nthis.run = getRGPListReport;', context);
    await context.run({ OrganizationID: 1, Status, FromDate: '2026-10-01', ToDate: '2026-10-07' });
    assert.equal(queries.length, 2);
    for (const query of queries) {
      assert.ok(query.sql.includes(expected), Status);
      assert.match(query.sql, /m.CreatedDate::DATE >= \$2::DATE/);
      assert.match(query.sql, /m.CreatedDate::DATE <= \$3::DATE/);
      if (Status === 'All RGP Overdue') assert.match(query.sql, /m.ExpectedReturnDate::DATE < CURRENT_DATE/);
    }
    assert.deepEqual(queries[0].values, [1, '2026-10-01', '2026-10-07']);
    assert.deepEqual(queries[1].values, [1, '2026-10-01', '2026-10-07', 10, 0]);
  }
});
