const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
test('unknown push payloads display a safe fallback notification and clicks stay in the notification app', async () => {
    const events = {}, shown = [], opened = [];
    const scope = 'https://example.test/Silly-Pop/and/';
    const self = { addEventListener: (name, fn) => events[name] = fn,
        registration: { scope, showNotification: async (...args) => shown.push(args) },
        clients: { matchAll: async () => [], openWindow: async url => opened.push(url) } };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../docs/and/sw.js'), 'utf8'), { self, URL });
    let waiting;
    for (const data of [null, { json: () => { throw Error(); } }, { json: () => ({ title: 'untrusted content', url: 'https://evil.test/', body: 'chat secret' }) }]) {
        events.push({ data, waitUntil: p => waiting = p }); await waiting;
    }
    assert.equal(shown.length, 3);
    assert.ok(shown.every(([title, options]) => title === '답장이 도착했어요' && options.body === '' && options.data.url === scope));
    events.notificationclick({ notification: { close() {}, data: { url: 'https://evil.test' } }, waitUntil: p => waiting = p });
    await waiting; assert.deepEqual(opened, [scope]);
});


test('worker displays APK character titles, fallback, and test notifications', async () => {
    const events = {}, shown = [];
    const self = { addEventListener: (name, fn) => events[name] = fn,
        registration: { scope: 'https://example.test/', showNotification: async (...args) => shown.push(args) } };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../docs/and/sw.js'), 'utf8'), { self, URL });
    const cases = [
        [{ characterName: '김홍진' }, '김홍진의 답장이 도착했어요'],
        [{ characterName: ' \n ' }, '답장이 도착했어요'],
        [{ characterName: { value: 'wrong type' } }, '답장이 도착했어요'],
        [{ characterName: ' 가\u0000나 ' }, '가 나의 답장이 도착했어요'],
        [{ characterName: '가'.repeat(120) }, `${'가'.repeat(80)}의 답장이 도착했어요`],
        [{ title: 'Silly-Pop 테스트', characterName: '김홍진' }, 'Silly-Pop 테스트'],
    ];
    for (const [payload, expected] of cases) {
        let waiting;
        events.push({ data: { json: () => payload }, waitUntil: p => waiting = p });
        await waiting;
        assert.equal(shown.at(-1)[0], expected);
    }
});
