const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function controller(service) {
    const exports = {};
    vm.runInNewContext(fs.readFileSync(path.join(__dirname,
        '../../controllers/CapexController/CapexController.js'), 'utf8'), {
        exports, console,
        require(name) {
            if (name.endsWith('/CapexService')) return service;
            if (name.endsWith('/statusCodes')) return { SUCCESS:200, BAD_REQUEST:400, UNAUTHORIZED:401 };
            if (name.endsWith('/AppError')) return require('../../utils/AppError');
            if (name.endsWith('/errorHandler')) return (error,res) => res.status(error.statusCode).json({message:error.message});
            return {};
        }
    });
    return exports;
}
function response() {
    return { headers:{}, setHeader(key,value){this.headers[key]=value;},
        status(code){this.code=code;return this;},send(body){this.body=body;return this;},
        json(body){this.body=body;return this;} };
}
test('List PDF passes verified JWT identity, not query identity, with report filters', async () => {
    let received;
    const pdf=Buffer.from('%PDF-test');
    const api=controller({generateCapexListPdf:async data=>{
        received=data;return {success:true,fileName:'report.pdf',data:pdf};
    }});
    const res=response();
    await api.generateCapexListPdf({user:{UserID:7,UserType:'GM',LoginType:'User'},query:{
        UserID:999,UserType:'OWNER',OrganizationID:'20',Status:'',Department:'',
        FromDate:'2026-09-01',ToDate:'2026-09-30',ApprovalFlow:'FC'
    }},res);
    assert.equal(received.UserID,7);
    assert.equal(received.UserType,'GM');
    assert.equal(received.OrganizationID,20);
    assert.equal(received.FromDate,'2026-09-01');
    assert.equal(received.ApprovalFlow,'FC');
    assert.equal(res.code,200);
    assert.equal(res.headers['Content-Type'],'application/pdf');
    assert.equal(res.body,pdf);
});
test('List PDF rejects missing authenticated identity before calling service', async () => {
    let called=false;
    const api=controller({generateCapexListPdf:async()=>{called=true;}});
    const res=response();
    await api.generateCapexListPdf({query:{UserID:7,OrganizationID:20}},res);
    assert.equal(res.code,401);
    assert.equal(called,false);
});
