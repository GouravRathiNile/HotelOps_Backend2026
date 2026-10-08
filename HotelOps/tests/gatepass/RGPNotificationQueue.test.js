const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const QUEUE = require("../../config/queue");
const { normalizeRGPApprovalRole } = require("../../services/GatepassService/RGPApprovalRoles");

const root = path.resolve(__dirname, "../..");
const master = { rgpid: "42", organizationid: "20", departmentid: "7", createdby: "1" };
const eventFor = (action, stage = 0) => ({ master, action,
  approvalID: action === "CREATE" ? undefined : String(101 + stage), remarks: "Vendor details need correction.",
  approvals: ["HOD", "DOF", "GM"].map((approvalrole, index) => ({
    rgpapprovalid: String(101 + index), approvalrole, approvalorder: index + 1, approvallevel: index + 1,
    status: index < stage ? "Approved" : "Pending", actionby: index < stage ? String(index + 2) : null,
  })),
});

async function harness({ mode = "success", noRecipients = false } = {}) {
  const callbacks = new Map(), notifications = [], recipients = [], publications = [], pushes = [], errors = [];
  let correlation = 0;
  const channel = {
    assertQueue: async () => {},
    consume: async (queue, callback) => { callbacks.set(queue, callback); },
    ack: () => {},
    nack: () => errors.push("Unexpected negative acknowledgment"),
    sendToQueue: (queue, content, properties) => {
      publications.push({ queue, data: JSON.parse(content.toString()) });
      if (mode !== "timeout") {
        const callback = callbacks.get(queue);
        assert.ok(callback, `No consumer registered for ${queue}`);
        queueMicrotask(() => callback({ content, properties }));
      }
      return true;
    },
  };
  const pool = {
    query: async (sql, params) => {
      if (sql.includes("FROM user_device")) return { rows: [{ token: "test-device" }] };
      assert.match(sql, /om.OrganizationID = \$1/);
      assert.equal(params[0], "20");
      const ids = params[1] ? { HOD: ["2"], FC: ["3", "8"], GM: ["4"] }[params[1]] : params[3];
      return { rows: noRecipients ? [] : ids.map(userid => ({ userid,
        shortname: "NH", rgpdepartmentname: "Engineering", itemnames: ["Pump"] })) };
    },
    connect: async () => {
      let pending, pendingRecipients = [];
      return {
        release: () => {},
        query: async (sql, params = []) => {
          if (sql === "BEGIN" || sql.includes("pg_advisory_xact_lock")) return { rows: [] };
          if (sql === "ROLLBACK") { pending = null; pendingRecipients = []; return { rows: [] }; }
          if (sql === "COMMIT") {
            if (pending) notifications.push(pending);
            recipients.push(...pendingRecipients);
            return { rows: [] };
          }
          if (/SELECT id FROM notifications/.test(sql)) {
            return { rows: notifications.filter(row => row.organization_id === params[0] &&
              row.module_name === params[1] && row.entity_type === params[2] &&
              row.entity_id === params[3] && row.action === params[4]) };
          }
          if (/INSERT INTO notifications\s/.test(sql)) {
            if (mode === "persistence-failure") throw new Error("Notification database unavailable");
            pending = { id: notifications.length + 1, organization_id: params[0], title: params[1],
              message: params[2], type: params[3], module_name: params[4], action: params[5],
              entity_type: params[6], entity_id: params[7] };
            return { rows: [pending] };
          }
          if (sql.includes("INSERT INTO notification_recipients")) {
            for (let i = 0; i < params.length; i += 2) {
              pendingRecipients.push({ notificationId: params[i], userId: params[i + 1] });
            }
            return { rows: [] };
          }
          throw new Error(`Unexpected SQL: ${sql}`);
        },
      };
    },
  };
  // Execute the production modules rather than stubbing publishNotification:
  // resolver -> producer RPC -> consumer -> handler -> generic DB persistence.
  const load = (file, dependencies) => {
    const context = { module: { exports: {} }, Buffer, process: { env: {} },
      console: { log: () => {}, warn: () => {}, error: (...args) => errors.push(args.join(" ")) },
      setTimeout: callback => {
        if (mode === "timeout") queueMicrotask(callback);
        return {};
      }, clearTimeout: () => {},
      require: name => {
        assert.ok(Object.hasOwn(dependencies, name), `Unmapped import in ${file}: ${name}`);
        return dependencies[name];
      },
    };
    vm.runInNewContext(fs.readFileSync(path.join(root, file), "utf8"), context, { filename: file });
    return context.module.exports;
  };
  const databaseError = { retryableDatabaseResponse: () => null };
  const generic = load("services/NotificationService/NotificationService.js", {
    "../../db": { pool }, "../../utils/retryableDatabaseError": databaseError,
    "../../utils/sendPushNotification": { sendPushNotification: async payload => {
      assert.ok(notifications.some(row => row.id === payload.data.notificationId));
      pushes.push(payload);
    } },
    "../CapexService/CapexEmailTemplate": { sendNotificationEmail: () => assert.fail("RGP must not email") },
    "../../AzurConfigration/ITAdmin/OrganizationMaster/AzureGetData": () => "test-logo",
  });
  const handler = load("consumer/NotificationConsumer/NotificationHandler.js", {
    "../../services/NotificationService/NotificationService": generic,
    "../../utils/retryableDatabaseError": databaseError,
  });
  const { startConsumer } = load("consumer/consumer.js", { "./rabbitmq": { getChannel: () => channel } });
  await startConsumer(QUEUE.NOTIFICATION.REQUEST, QUEUE.NOTIFICATION.RESPONSE, handler);
  const producer = load("producer/producer.js", { uuid: { v4: () => String(++correlation) },
    "./rabbitmq": { getChannel: () => mode === "disconnected" ? null : channel } });
  const dispatcher = load("services/GatepassService/GatepassNotificationService.js", {
    "../../db": { pool }, "./RGPApprovalRoles": { normalizeRGPApprovalRole },
    "../../producer/producer": producer, "../../config/queue": QUEUE,
  });
  return { dispatcher, notifications, recipients, publications, pushes, errors };
}

const scenarios = [["CREATE", 0, ["2"]], ["APPROVE", 0, ["3", "8"]],
  ["APPROVE", 1, ["4"]], ["APPROVE", 2, ["1"]]];
for (const action of ["REJECT", "CANCEL"]) {
  for (const stage of [0, 1, 2]) scenarios.push([action, stage, stage ? ["1", String(stage + 1)] : ["1"]]);
}
for (const [action, stage, expectedUsers] of scenarios) {
  test(`queue round trip: ${action} at stage ${stage + 1} persists the correct notification`, async () => {
    const h = await harness();
    const event = eventFor(action, stage);
    const result = await h.dispatcher.notifyCommittedRGPEvent(event);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(result.failed, undefined, h.errors.join("\n"));
    assert.equal(h.notifications.length, 1);
    assert.equal(h.notifications[0].organization_id, "20");
    assert.equal(h.notifications[0].module_name, "Gatepass");
    assert.equal(h.notifications[0].entity_type, "RGP");
    assert.equal(h.notifications[0].action, action === "CREATE" ? "RGP_CREATED" : `RGP_APPROVAL_${101 + stage}_${action}`);
    assert.deepEqual(h.recipients.map(row => row.userId).sort(), expectedUsers);
    assert.equal(h.publications[0].queue, QUEUE.NOTIFICATION.REQUEST);
    assert.equal(h.publications[0].data.action, "CREATE_NOTIFICATION");
    assert.equal(h.pushes.length, 1);
    // Replay through the same RPC/consumer path must not duplicate persistence or push.
    await h.dispatcher.notifyCommittedRGPEvent(event);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.notifications.length, 1);
    assert.equal(h.pushes.length, 1);
    assert.deepEqual(h.errors, []);
  });
}

for (const mode of ["disconnected", "timeout", "persistence-failure"]) {
  test(`default queue publisher isolates ${mode}`, async () => {
    const h = await harness({ mode });
    const result = await h.dispatcher.notifyCommittedRGPEvent(eventFor("CREATE"));
    assert.equal(result.failed, true);
    assert.equal(h.notifications.length, 0);
    assert.ok(h.errors.some(error => error.includes("RGP notification failed")));
  });
}

test("no eligible recipients never publishes a notification request", async () => {
  const h = await harness({ noRecipients: true });
  assert.equal((await h.dispatcher.notifyCommittedRGPEvent(eventFor("APPROVE"))).skipped, true);
  assert.equal(h.publications.length, 0);
});
