const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const pairingMessage = 'Silly-Pop 앱에서 연결 명령을 복사해 Termux에 한 번 붙여넣어 주세요.';
function readKey() {
    const file = path.join(os.homedir(), '.config', 'silly-pop', 'bridge-key');
    try {
        const stat = fs.lstatSync(file);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 128
            || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid()) throw new Error();
        const value = fs.readFileSync(file, 'utf8').trim();
        if (!/^[a-f0-9]{64}$/.test(value)) throw new Error();
        return Buffer.from(value, 'hex');
    } catch {
        throw new Error(pairingMessage);
    }
}
function sign(action, fields = {}, key = readKey(), now = Date.now(), nonce = crypto.randomBytes(16).toString('hex')) {
    const payload = JSON.stringify({v: 1, action, ts: now, nonce,
        title: fields.title || '', url: fields.url || '', sound: Boolean(fields.sound), vibrate: Boolean(fields.vibrate)});
    const signature = crypto.createHmac('sha256', key).update(payload, 'utf8').digest('hex');
    return {payload, signature};
}
module.exports = {readKey, sign};
