const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

test("CAPEX Firebase resolves saved Regional assignment; other modules keep direct membership", async () => {
    const filename = path.resolve(__dirname, "../../services/NotificationService/NotificationService.js");
    const calls = [], pushed = [];
    const context = { module: { exports: {} }, console, process, Buffer };
    context.require = name => {
        if (name === "../../db") return { pool: { query: async (sql, values) => {
            calls.push({ sql, values }); return { rows: [{ token: "test-device" }] };
        } } };
        if (name === "../../utils/sendPushNotification") return { sendPushNotification: async data => pushed.push(data) };
        return require(name.startsWith(".") ? path.resolve(path.dirname(filename), name) : name);
    };
    vm.runInNewContext(fs.readFileSync(filename, "utf8") +
        "\nmodule.exports.testPush = pushNotificationToRecipients;", context);
    const event = { module_name: "Capex", entity_type: "Capex", entity_id: "7", organization_id: "20", id: "1" };
    await context.module.exports.testPush(event, ["42"]);
    assert.match(calls[0].sql, /user_primary_organization/);
    assert.match(calls[0].sql, /regional_step.assigneduserid = um.userid/);
    assert.match(calls[0].sql, /regional_step.capexid = \$3::bigint/);
    assert.match(calls[0].sql, /COALESCE\(om.parentorganizationid, om.organizationid\)/);
    assert.deepEqual(JSON.parse(JSON.stringify(calls[0].values)), [["42"], "20", "7"]);
    await context.module.exports.testPush({ ...event, module_name: "Opex", entity_type: "Opex" }, ["42"]);
    assert.match(calls[1].sql, /INNER JOIN user_org_mapping uom ON uom.userid = um.userid/);
    assert.ok(!calls[1].sql.includes("regional_step"));
    assert.equal(calls[1].values.length, 2);
    assert.equal(pushed.length, 2);
});
