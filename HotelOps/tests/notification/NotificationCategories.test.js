const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.resolve(__dirname,
  "../../services/NotificationService/NotificationService.js"), "utf8").replace(/\r\n/g, "\n");
const categorySQL = source.match(/const notificationCategorySQL = `([\s\S]*?)`;/)[1];
function service() {
  const calls = [];
  const context = { module: { exports: {} }, console, require(name) {
    if (name === "../../db") return { pool: { async query(sql, params) {
      calls.push({ sql, params });
      return { rows: sql.includes("total_count") ? [{ total_count: "0" }] : [] };
    } } };
    return {};
  } };
  vm.runInNewContext(source, context);
  return { api: context.module.exports, calls };
}

for (const [filter, category] of [["AMC Renewal", "AMC Renewal"],
  [" amc renewal ", "AMC Renewal"], ["Engineering", "Engineering"], ["Capex", "Capex"]]) {
  test(`${filter}: list pagination and unread counts share category filtering`, async () => {
    const { api, calls } = service();
    await api.getNotifications({ userId: 7, moduleName: filter, page: 2, limit: 10 });
    await api.getUnreadCount(7, filter);
    assert.equal(calls.length, 4);
    for (const call of calls) {
      assert.ok(call.sql.includes(`${categorySQL} = $2`));
      assert.equal(call.params[0], 7);
      assert.equal(call.params[1], category);
      assert.ok(call.sql.includes("nr.is_read = FALSE"));
    }
    assert.ok(calls[1].sql.includes(`${categorySQL} AS module_name`));
    assert.deepEqual(Array.from(calls[1].params), [7, category, 10, 10]);
    assert.ok(calls[3].sql.includes(`GROUP BY ${categorySQL}`));
  });
}

test("unfiltered list and badges use the same category without title matching", async () => {
  const { api, calls } = service();
  await api.getNotifications({ userId: 7 });
  await api.getUnreadCount(7);
  assert.ok(calls[1].sql.includes(`${categorySQL} AS module_name`));
  assert.ok(calls[3].sql.includes(`${categorySQL} AS "moduleName"`));
  assert.ok(calls[3].sql.includes(`GROUP BY ${categorySQL}`));
  assert.doesNotMatch(categorySQL, /title|message|action/);
  assert.match(categorySQL, /entity_type/);
  assert.match(categorySQL, /= 'AMC'/);
});
