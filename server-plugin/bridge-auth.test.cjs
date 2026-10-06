const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const auth = require('./bridge-auth.cjs');
const fixture = require('../android-app/app/src/androidTest/assets/bridge-auth-vector.json');
const message = JSON.parse(fixture.payload);
assert.deepEqual(auth.sign(message.action, message, Buffer.from(fixture.key, 'hex'), message.ts, message.nonce),
    {payload:fixture.payload,signature:fixture.signature});
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'silly-pop-auth-'));
const originalHome = process.env.HOME;
process.env.HOME = home;
const file = path.join(home, '.config', 'silly-pop', 'bridge-key');
try {
    assert.throws(()=>auth.readKey(), /연결 명령/);
    fs.mkdirSync(path.dirname(file), {recursive:true,mode:0o700});
    fs.writeFileSync(file, fixture.key, {mode:0o600});
    assert.equal(auth.readKey().toString('hex'), fixture.key);
    const signed = auth.sign(message.action, message);
    assert.equal(signed.signature, crypto.createHmac('sha256', auth.readKey()).update(signed.payload).digest('hex'));
    assert(!JSON.stringify(signed).includes(fixture.key), 'Transport must not contain the key');
    assert.notEqual(JSON.parse(signed.payload).nonce, JSON.parse(auth.sign(message.action, message).payload).nonce);
    fs.chmodSync(file, 0o644);
    assert.throws(()=>auth.readKey(), /연결 명령/);
    fs.chmodSync(file, 0o600);
    fs.writeFileSync(file, 'invalid');
    assert.throws(()=>auth.readKey(), /연결 명령/);
    fs.unlinkSync(file);
    fs.writeFileSync(file+'.target', fixture.key, {mode:0o600});
    fs.symlinkSync(file+'.target',file);
    assert.throws(()=>auth.readKey(), /연결 명령/);
} finally {
    if (originalHome === undefined) delete process.env.HOME; else process.env.HOME = originalHome;
    fs.rmSync(home,{recursive:true,force:true});
}
console.log('Bridge authentication tests passed (cross-language vector, private key file, random nonce, no key in payload).');
