const assert = require('node:assert/strict');
const http = require('node:http');

process.env.SILLY_POP_BRIDGE_COMMAND = '/bin/true';
process.env.SILLY_POP_COMPANION_INSTALLED = '1';

const plugin = require('./index.cjs');

function makeResponse() {
    return {
        statusCode: 200,
        body: undefined,
        status(code) {
            this.statusCode = code;
            return this;
        },
        json(body) {
            this.body = body;
            return this;
        },
    };
}

async function run() {
    const originalEnd = http.ServerResponse.prototype.end;
    const routes = { get: new Map(), post: new Map() };
    const router = {
        get(route, handler) { routes.get.set(route, handler); },
        post(route, handler) { routes.post.set(route, handler); },
    };

    await plugin.init(router);
    assert.notEqual(http.ServerResponse.prototype.end, originalEnd, 'response end should be patched');

    const statusResponse = makeResponse();
    routes.get.get('/status')({}, statusResponse);
    assert.equal(statusResponse.statusCode, 200);
    assert.equal(statusResponse.body.ok, true);
    assert.equal(statusResponse.body.appInstalled, true);
    assert.equal(statusResponse.body.bridgeCommand, true);
    assert.equal(statusResponse.body.appReady, true);

    const stateResponse = makeResponse();
    routes.get.get('/state')({
        query: {
            clientId: 'test-client',
            visible: '0',
            enabled: '1',
            backgroundOnly: '1',
            sound: '1',
            vibrate: '1',
            url: 'http://127.0.0.1:8000/',
        },
    }, stateResponse);
    assert.equal(stateResponse.body.ok, true);

    const testResponse = makeResponse();
    await routes.post.get('/test')({
        body: {
            sound: true,
            vibrate: true,
            url: 'http://127.0.0.1:8000/',
        },
    }, testResponse);
    assert.equal(testResponse.statusCode, 200);
    assert.equal(testResponse.body.ok, true);

    await plugin.exit();
    assert.equal(http.ServerResponse.prototype.end, originalEnd, 'response end should be restored');
}

run().then(
    () => console.log('Silly-Pop server companion tests passed.'),
    error => {
        console.error(error);
        process.exitCode = 1;
    },
);
