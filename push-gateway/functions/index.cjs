'use strict';
const {onRequest} = require('firebase-functions/v2/https');
const {initializeApp} = require('firebase-admin/app');
const {getAuth} = require('firebase-admin/auth');
const {getFirestore} = require('firebase-admin/firestore');
const {getMessaging} = require('firebase-admin/messaging');
const {createGateway} = require('./core.cjs');
initializeApp();
const db = getFirestore();
const gateway = createGateway({
    transaction: operation => db.runTransaction(tx => operation({
        get: async key => (await tx.get(db.doc(key))).data(),
        set: (key, value) => tx.set(db.doc(key), value),
        delete: key => tx.delete(db.doc(key)),
    })),
    send: message => getMessaging().send(message),
});
exports.push = onRequest({region: 'asia-northeast3', maxInstances: 3, timeoutSeconds: 30, cors: false}, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (req.method !== 'POST') return res.status(405).json({ok: false});
    if (!req.is('application/json') || !req.rawBody || req.rawBody.length > 8192) return res.status(400).json({ok: false});
    const bearer = /^Bearer ([^\s]+)$/.exec(req.get('authorization') || '')?.[1] || '';
    try {
        let result;
        if (['/device/register', '/device/pair', '/device/disconnect'].includes(req.path)) {
            let identity;
            try { identity = await getAuth().verifyIdToken(bearer); } catch { return res.status(401).json({ok: false, error: '앱 인증을 다시 시도해 주세요.'}); }
            result = await gateway.device(identity.uid, req.path.split('/')[2], req.body || {});
        } else if (req.path === '/pair/redeem') result = await gateway.redeem(req.body?.code);
        else if (['/sender/status', '/sender/disconnect', '/sender/notify'].includes(req.path)) result = await gateway.sender(bearer, req.path.split('/')[2], req.body || {});
        else return res.status(404).json({ok: false});
        return res.json(result);
    } catch (error) {
        // Do not log request bodies, auth headers, tokens or FCM error contents.
        return res.status(error.status || 500).json({ok: false, error: error.status ? error.message : '알림 서버에 일시적인 문제가 있어요.'});
    }
});
