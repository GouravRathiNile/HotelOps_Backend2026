const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

test('token device registration reaches UserService through the USER queue', async () => {
  const request = { Token: 'test-token', DeviceID: 'device-id', DeviceToken: 'device-token', DeviceType: 'ANDROID' };
  const success = { success: true, data: { UserID: 1 } };
  let received;
  const handlerContext = {
    console,
    module: { exports: {} },
    require: name => {
      if (name.includes('UserService')) return { verifyTokenAndRegisterDevice: async data => { received = data; return success; } };
      if (name.includes('retryableDatabaseError')) return { retryableDatabaseResponse: () => null };
      throw new Error('Unexpected dependency');
    },
  };
  vm.createContext(handlerContext);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../../consumer/ITAdminConsumer/UserHandler.js'), 'utf8'), handlerContext);
  const controllerSource = fs.readFileSync(path.join(__dirname, '../../controllers/ITAdminController/UserController.js'), 'utf8');
  const start = controllerSource.indexOf('exports.verifyTokenAndRegisterDevice =');
  const end = controllerSource.indexOf('\n};', start) + 3;
  const context = {
    exports: {},
    QUEUE: { USER: { REQUEST: 'user-request', RESPONSE: 'user-response' }, AUTH: { REQUEST: 'auth-request', RESPONSE: 'auth-response' } },
    STATUS_CODES: { SUCCESS: 200 },
    handleError: error => { throw error; },
    producer: { sendMessage: async (requestQueue, responseQueue, message) => {
      assert.equal(requestQueue, 'user-request');
      assert.equal(responseQueue, 'user-response');
      assert.equal(message.action, 'VERIFY_TOKEN_REGISTER_DEVICE');
      return handlerContext.module.exports(message);
    } },
  };
  vm.createContext(context);
  vm.runInContext(controllerSource.slice(start, end), context);
  let response;
  const res = { status: code => { assert.equal(code, 200); return res; }, json: value => { response = value; } };
  await context.exports.verifyTokenAndRegisterDevice({ body: { Token: request.Token }, headers: { deviceid: request.DeviceID, devicetoken: request.DeviceToken, devicetype: 'android' } }, res);
  assert.deepEqual(JSON.parse(JSON.stringify(received)), request);
  assert.equal(response, success);
});
