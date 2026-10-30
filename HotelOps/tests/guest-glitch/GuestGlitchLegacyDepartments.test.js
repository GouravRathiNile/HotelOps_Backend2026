const test = require("node:test");
const assert = require("node:assert/strict");
const dbPath = require.resolve("../../db");
const pool = { query: async () => ({ rows: [] }) };
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { pool } };
const repository = require("../../repositories/GuestGlitchRepository/GuestGlitchRepository");
const { listResponseDTO } = require("../../dto/GuestGlitchDTO");

test("legacy department names resolve to organization-scoped IDs and names", async () => {
  const client = { query: async (sql, values) => {
    assert.match(sql, /organizationid = \$1 AND isdeleted = FALSE/);
    assert.match(sql, /LOWER\(TRIM\(departmentname\)\)/);
    assert.deepEqual(values, [401, ["front office", "housekeeping", "retired"]]);
    return { rows: [
      { departmentid: "12", departmentname: "Front Office" },
      { departmentid: "13", departmentname: "Housekeeping" },
    ] };
  } };
  const row = { id: 1, departmentids: [], department: " front office,Housekeeping,FRONT OFFICE,Retired " };
  const [resolved] = await repository.resolveSelections(client, 401, [row]);
  assert.deepEqual(listResponseDTO(row, resolved).Departments, [
    { ID: 12, Name: "Front Office" },
    { ID: 13, Name: "Housekeeping" },
    { ID: null, Name: "Retired" },
  ]);
});

test("stored IDs take precedence over legacy snapshots and empty departments stay empty", async () => {
  const client = { query: async (sql, values) => {
    assert.match(sql, /departmentid = ANY/);
    assert.deepEqual(values, [401, [12]]);
    return { rows: [{ departmentid: "12", departmentname: "Front Office" }] };
  } };
  const result = await repository.resolveSelections(client, 401, [
    { departmentids: [12], department: "Outdated name" },
    { departmentids: null, department: null },
  ]);
  assert.deepEqual(result.map((row) => row.departments), [[{ ID: 12, Name: "Front Office" }], []]);
});

test("list selects legacy department snapshots for resolution", async () => {
  pool.query = async (sql) => {
    if (/COUNT\(/i.test(sql)) return { rows: [{ total: "0" }] };
    assert.match(sql, /gg\.department\s*,/);
    return { rows: [] };
  };
  await repository.list({ page: 1, pageSize: 10 }, 401);
});
