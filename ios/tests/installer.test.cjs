const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const installer = require.resolve('../install.cjs');
const installerRequire = createRequire(installer);
function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'silly-ios-installer-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const protectedFiles = ['server.js', 'config.yaml', 'data/default-user/chats/keep.jsonl', 'plugins/Silly-Pop-AND/keep', 'plugins/Silly-Relay/keep'];
    for (const f of protectedFiles) {
        fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true }); fs.writeFileSync(path.join(root, f), 'preserve');
    }
    const run = (failNpm = false, extra = {}) => vm.runInNewContext(fs.readFileSync(installer, 'utf8'), {
        __dirname: path.dirname(installer), console: { log() {} },
        process: { argv: ['node', installer, root], platform: process.platform },
        require: name => name === 'node:child_process' ? { execFileSync(command, args, options) {
            assert.equal(command, process.platform === 'win32' ? 'npm.cmd' : 'npm');
            assert.equal(args.join(' '), 'ci --omit=dev --ignore-scripts --no-audit --no-fund');
            assert.ok(options.cwd.startsWith(root + path.sep));
            if (failNpm) throw new Error('fixture npm failure');
        } } : name === 'node:fs' ? { ...fs, ...extra } : installerRequire(name),
    });
    const checkProtected = () => {
        for (const f of protectedFiles) assert.equal(fs.readFileSync(path.join(root, f), 'utf8'), 'preserve');
        assert.equal(fs.readdirSync(root).some(n => n.startsWith('.silly-pop-ios-install-')), false);
    };
    return { root, run, checkProtected };
}
test('installer targets only iOS; update backs up iOS and leaves chat/iOS/Relay/config untouched', t => {
    const f = fixture(t); f.run(); f.run(); f.checkProtected();
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.root, 'plugins/Silly-Pop-iOS/package.json'))).name, 'silly-pop-ios');
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.root, 'data/default-user/extensions/Silly-Pop-iOS/manifest.json'))).display_name, 'Silly-Pop iOS');
    assert.equal(typeof require(path.join(f.root, 'plugins/Silly-Pop-iOS/server/reply-response.cjs')).inspectResponse, 'function');
    assert.equal(fs.readdirSync(path.join(f.root, '.silly-pop-ios-backups')).length, 1);
});
test('dependency failure and mid-install failure roll back without changing existing installations', t => {
    const f = fixture(t); f.run();
    const target = path.join(f.root, 'plugins/Silly-Pop-iOS/server/core.cjs');
    fs.writeFileSync(target, 'previous iOS version');
    assert.throws(() => f.run(true), /npm failure/);
    assert.equal(fs.readFileSync(target, 'utf8'), 'previous iOS version');
    assert.throws(() => f.run(false, { renameSync(from, to) {
        if (from.includes('.silly-pop-ios-install-') && from.endsWith(path.sep + 'extension')) throw Error('fixture rename failure');
        return fs.renameSync(from, to);
    } }), /rename failure/);
    assert.equal(fs.readFileSync(target, 'utf8'), 'previous iOS version'); f.checkProtected();
});
test('unrelated target folder is refused without removal', t => {
    const f = fixture(t), target = path.join(f.root, 'plugins/Silly-Pop-iOS');
    fs.mkdirSync(target); fs.writeFileSync(path.join(target, 'keep'), 'unrelated');
    assert.throws(() => f.run(), /덮어쓰지/);
    assert.equal(fs.readFileSync(path.join(target, 'keep'), 'utf8'), 'unrelated'); f.checkProtected();
});
