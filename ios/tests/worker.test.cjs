const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
test('every push displays a fixed safe notification and clicks stay in the notification app', async () => {
    const events = {}, shown = [], opened = [];
    const scope = 'https://example.test/Silly-Pop/';
    const self = { addEventListener: (name, fn) => events[name] = fn,
        registration: { scope, showNotification: async (...args) => shown.push(args) },
        clients: { matchAll: async () => [], openWindow: async url => opened.push(url) } };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../docs/sw.js'), 'utf8'), { self, URL });
    let waiting;
    for (const data of [null, { json: () => { throw Error(); } }, { json: () => ({ title: 'untrusted content', url: 'https://evil.test/', body: 'chat secret' }) }]) {
        events.push({ data, waitUntil: p => waiting = p }); await waiting;
    }
    assert.equal(shown.length, 3);
    assert.ok(shown.every(([title, options]) => title === '답장이 도착했어요' && options.body === '' && options.data.url === scope));
    events.notificationclick({ notification: { close() {}, data: { url: 'https://evil.test' } }, waitUntil: p => waiting = p });
    await waiting; assert.deepEqual(opened, [scope]);
});
