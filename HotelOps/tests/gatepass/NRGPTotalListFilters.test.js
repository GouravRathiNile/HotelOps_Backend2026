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
  const start = source.indexOf('const getTotalNRGP =');
  const end = source.indexOf('\n};', start) + 3;
  vm.runInContext(source.slice(start, end) + '\nthis.run = getTotalNRGP;', context);
  let result;
  try { result = await context.run({ OrganizationID: 1, ...data }); }
  catch (error) { if (error.message !== 'query captured') throw error; }
  return { result, queries };
}

test('NRGP total filters support single, multiple and repeated month/year values', async () => {
  for (const [input, expected] of [
    [{ Month: '10', Year: '2026' }, [1, [10], [2026]]],
    [{ Month: '1, 2,1', Year: '2025,2026' }, [1, [1, 2], [2025, 2026]]],
    [{ Month: ['1', '2,3'], Year: ['2025', '2026'] }, [1, [1, 2, 3], [2025, 2026]]],
  ]) {
    const { queries } = await filters(input);
    assert.deepEqual(queries[0].values, expected);
    assert.match(queries[0].sql, /EXTRACT\(MONTH FROM m.CreatedDate\)::INTEGER = ANY\(\$2::INTEGER\[\]\)/);
    assert.match(queries[0].sql, /EXTRACT\(YEAR FROM m.CreatedDate\)::INTEGER = ANY\(\$3::INTEGER\[\]\)/);
  }
});

test('NRGP total month and year are optional and old date filters are removed', async () => {
  for (const input of [{}, { FromDate: '2026-01-01', ToDate: '2026-01-31' }, { Month: 10 }, { Year: 2026 }]) {
    const { queries } = await filters(input);
    assert.doesNotMatch(queries[0].sql, /CreatedDate::DATE/);
    assert.equal(queries[0].values.length, input.Month || input.Year ? 2 : 1);
  }
});

test('NRGP total rejects invalid month/year before querying the database', async () => {
  for (const input of [{ Month: 0 }, { Month: 13 }, { Month: '1,' }, { Month: [] }, { Month: '1.5' }, { Year: 'abc' }, { Year: 0 }, { Year: 10000 }]) {
    const { result, queries } = await filters(input);
    assert.equal(result.success, false);
    assert.equal(result.statusCode, 400);
    assert.equal(queries.length, 0);
  }
});

test('NRGP total ignores empty month/year query parameters', async () => {
  for (const [input, expected] of [
    [{ Month: '', Year: '2025,2026' }, [1, [2025, 2026]]],
    [{ Month: '', Year: '' }, [1]],
    [{ Month: '  ', Year: '  ' }, [1]],
    [{ Month: '10', Year: '' }, [1, [10]]],
  ]) {
    const { queries } = await filters(input);
    assert.equal(queries.length, 1);
    assert.deepEqual(queries[0].values, expected);
    if (expected.length === 1) assert.doesNotMatch(queries[0].sql, /EXTRACT/);
  }
});
