const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname,
  "../../services/NotificationService/NotificationService.js"), "utf8");
const event = { organizationId: 20, moduleName: " gatepass ", entityType: "RGP", entityId: "42",
  action: "RGP_CREATED", userIds: [1, "1", 2], title: "RGP #1007 — Nile Hotel",
  message: "RGP #1007 has been created and is awaiting Department HOD approval." };

// A transactional fake with real asynchronous lock contention exercises both
// deliveries through createNotification, including its duplicate-return path.
function harness({ recipientFailure = false, pushFailure = false, commitFailure = false } = {}) {
  const rows = [], recipientRows = [], pushes = [], emails = [], calls = [];
  const locks = new Map();
  let nextID = 1;
  const pool = {
    query: async (sql) => {
      assert.match(sql, /FROM user_device/);
      return { rows: [{ token: "device-token" }] };
    },
    connect: async () => {
      let pending = null, recipients = [], unlock = null, lockHeld = false;
      const releaseLock = () => { if (unlock) unlock(); unlock = null; lockHeld = false; };
      return {
        release: releaseLock,
        query: async (sql, params = []) => {
          calls.push(sql.trim());
          if (sql === "BEGIN") return { rows: [] };
          if (sql === "COMMIT") {
            if (commitFailure) throw new Error("Commit failed");
            if (pending) rows.push(pending);
            recipientRows.push(...recipients);
            pending = null;
            releaseLock();
            return { rows: [] };
          }
          if (sql === "ROLLBACK") {
            pending = null;
            recipients = [];
            releaseLock();
            return { rows: [] };
          }
          if (sql.includes("pg_advisory_xact_lock")) {
            const previous = locks.get(params[0]) || Promise.resolve();
            const current = new Promise(resolve => { unlock = resolve; });
            locks.set(params[0], previous.then(() => current));
            await previous;
            lockHeld = true;
            return { rows: [] };
          }
          if (/SELECT id FROM notifications/.test(sql)) {
            assert.equal(lockHeld, true);
            assert.match(sql, /organization_id = \$1 AND module_name = \$2/);
            assert.match(sql, /entity_type = \$3 AND entity_id = \$4 AND action = \$5/);
            return { rows: rows.filter(row => row.organization_id === params[0] && row.module_name === params[1] &&
              row.entity_type === params[2] && row.entity_id === params[3] && row.action === params[4]) };
          }
          if (/INSERT INTO notifications\s/.test(sql)) {
            pending = { id: nextID++, organization_id: params[0], title: params[1], message: params[2],
              type: params[3], module_name: params[4], action: params[5], entity_type: params[6],
              entity_id: params[7], priority: params[11] };
            return { rows: [pending] };
          }
          if (/INSERT INTO notification_recipients/.test(sql)) {
            if (recipientFailure) throw new Error("Recipient insert failed");
            for (let index = 0; index < params.length; index += 2) {
              recipients.push({ notification_id: params[index], user_id: params[index + 1] });
            }
            return { rows: [] };
          }
          throw new Error(`Unexpected SQL: ${sql}`);
        },
      };
    },
  };
  const context = { module: { exports: {} }, console: { error: () => {} }, process: { env: {} },
    require: (name) => {
      if (name === "../../db") return { pool };
      if (name.includes("retryableDatabaseError")) return { retryableDatabaseResponse: () => null };
      if (name.includes("sendPushNotification")) return { sendPushNotification: async (payload) => {
        assert.ok(rows.some(row => row.id === payload.data.notificationId), "Push must follow notification commit");
        pushes.push(payload);
        if (pushFailure) throw new Error("Firebase unavailable");
      } };
      if (name.includes("CapexEmailTemplate")) return { sendNotificationEmail: async (...args) => emails.push(args) };
      if (name.includes("AzureGetData")) return () => "logo";
      throw new Error(`Unexpected dependency: ${name}`);
    },
  };
  vm.runInNewContext(source, context);
  return { create: context.module.exports.createNotification, rows, recipientRows, pushes, emails, calls };
}
const flush = () => new Promise(resolve => setImmediate(resolve));

test("concurrent duplicate creation events persist and push once with unique recipients", async () => {
  const h = harness();
  const results = await Promise.all([h.create(event), h.create({ ...event, moduleName: "Gatepass" })]);
  await flush();
  assert.ok(results.every(result => result.success));
  assert.deepEqual(results.map(result => result.statusCode).sort(), [200, 201]);
  assert.equal(h.rows.length, 1);
  assert.equal(h.rows[0].module_name, "Gatepass");
  assert.deepEqual(h.recipientRows.map(row => row.user_id), ["1", "2"]);
  assert.equal(h.pushes.length, 1);
  assert.equal(h.emails.length, 0);
});

test("approval/rejection/cancellation redelivery is idempotent per persisted stage", async () => {
  for (const action of ["APPROVE", "REJECT", "CANCEL"]) {
    const h = harness();
    const payload = { ...event, action: `RGP_APPROVAL_101_${action}` };
    await h.create(payload);
    await h.create(payload);
    await flush();
    assert.equal(h.rows.length, 1);
    assert.equal(h.pushes.length, 1);
  }
});

test("organization, RGP ID and repeated configured stage IDs remain separate events", async () => {
  const h = harness();
  for (const changes of [
    { action: "RGP_APPROVAL_101_APPROVE" }, { action: "RGP_APPROVAL_102_APPROVE" },
    { action: "RGP_APPROVAL_101_APPROVE", organizationId: 21 },
    { action: "RGP_APPROVAL_101_APPROVE", entityId: "43" },
  ]) assert.equal((await h.create({ ...event, ...changes })).statusCode, 201);
  assert.equal(h.rows.length, 4);
  await flush();
});

test("failed notification persistence rolls back without dispatching Firebase", async () => {
  for (const failure of [{ recipientFailure: true }, { commitFailure: true }]) {
    const h = harness(failure);
    assert.equal((await h.create(event)).success, false);
    await flush();
    assert.equal(h.rows.length, 0);
    assert.equal(h.recipientRows.length, 0);
    assert.equal(h.pushes.length, 0);
    assert.ok(h.calls.includes("ROLLBACK"));
  }
});

test("Firebase failure preserves committed notification and duplicate delivery does not resend", async () => {
  const h = harness({ pushFailure: true });
  assert.equal((await h.create(event)).success, true);
  await flush();
  assert.equal((await h.create(event)).statusCode, 200);
  await flush();
  assert.equal(h.rows.length, 1);
  assert.equal(h.pushes.length, 1);
  assert.equal(h.emails.length, 0);
  assert.ok(!h.calls.includes("ROLLBACK"));
});

test("RGP idempotency does not change NRGP notification persistence", async () => {
  const h = harness();
  await h.create({ ...event, entityType: "NRGP" });
  await h.create({ ...event, entityType: "NRGP" });
  assert.equal(h.rows.length, 2);
  assert.ok(!h.calls.some(sql => sql.includes("pg_advisory_xact_lock")));
  await flush();
});
