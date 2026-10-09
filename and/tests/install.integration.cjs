// Runs real npm ci in a disposable ST fixture; never calls an AI or sends push.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'silly-and-install-integration-'));
try {
    const files = ['server.js', 'config.yaml', 'data/default-user/chats/keep.jsonl', 'plugins/Silly-Pop-iOS/keep', 'plugins/Silly-Relay/keep'];
    for (const file of files) {
        fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
        fs.writeFileSync(path.join(root, file), 'preserve');
    }
    for (let i = 0; i < 2; i++) {
        execFileSync(process.execPath, [path.join(__dirname, '../install.cjs'), root], { stdio: 'inherit' });
        assert.equal(require(path.join(root, 'plugins/Silly-Pop-AND/server/index.cjs')).info.id, 'silly-pop-and');
        for (const file of files) assert.equal(fs.readFileSync(path.join(root, file), 'utf8'), 'preserve');
    }
    assert.equal(fs.readdirSync(path.join(root, '.silly-pop-and-backups')).length, 1);
    console.log('Fresh install and update passed; existing data preserved.');
} finally { fs.rmSync(root, { recursive: true, force: true }); }
