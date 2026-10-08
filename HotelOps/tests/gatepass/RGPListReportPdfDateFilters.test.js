const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../../services/GatepassService/GatepassService.js'), 'utf8');

async function filters(data) {
  const queries = [];
  const context = {
    console: { error() {} },
    getRGPReportOrganizationName: async () => "Test Hotel",
    fail: (message, statusCode) => ({ success: false, message, statusCode }),
    databaseFailure: error => { throw error; },
    pool: { query: async (sql, values) => {
      queries.push({ sql, values: JSON.parse(JSON.stringify(values)) });
      throw new Error('query captured');
    } },
  };
  vm.createContext(context);
  const start = source.indexOf('const getRGPListReportPdf =');
  const end = source.indexOf('\n};', start) + 3;
  vm.runInContext(source.slice(start, end) + '\nthis.run = getRGPListReportPdf;', context);
  let result;
  try { result = await context.run({ OrganizationID: 1, ...data }); }
  catch (error) { if (error.message !== 'query captured') throw error; }
  return { result, queries };
}

test('RGP PDF report supports inclusive date ranges and either boundary', async () => {
  for (const input of [{}, { FromDate: '2026-10-01' }, { ToDate: '2026-10-07' }, { FromDate: '2026-10-07', ToDate: '2026-10-07' }]) {
    const { queries } = await filters(input);
    assert.equal(queries.length, 1);
    assert.deepEqual(queries[0].values, [1, ...Object.values(input)]);
    if (input.FromDate) assert.match(queries[0].sql, /m.CreatedDate::DATE >= \$2::DATE/);
    if (input.ToDate) assert.match(queries[0].sql, /m.CreatedDate::DATE <= \$[23]::DATE/);
  }
});

test('RGP PDF report rejects invalid dates and reversed ranges before querying', async () => {
  for (const input of [{ FromDate: '2026-02-30' }, { ToDate: 'invalid' }, { FromDate: ['2026-10-01'] }, { FromDate: '2026-10-08', ToDate: '2026-10-07' }]) {
    const { result, queries } = await filters(input);
    assert.equal(result.success, false);
    assert.equal(result.statusCode, 400);
    assert.equal(queries.length, 0);
  }
});

test('PDF Open filter includes Pending and Approved', async () => {
  const { queries } = await filters({ Status: 'All RGP Open' });
  assert.ok(queries[0].sql.includes("IN ('PENDING', 'APPROVED')"));
});

test('PDF Out filter includes checked out and partial returns', async () => {
  const { queries } = await filters({ Status: 'All RGP Out' });
  assert.ok(queries[0].sql.includes("IN ('CHECKED OUT', 'RETURN PENDING')"));
});
