'use strict';
// Explicit paths only; never edit config, chat files, Android app or existing Relay.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const root = path.resolve(process.argv[2] || path.join(os.homedir(), 'SillyTavern'));
const user = process.argv[3] || 'default-user';
if (!/^[A-Za-z0-9_-]+$/.test(user) || !fs.existsSync(path.join(root, 'server.js')) || !fs.existsSync(path.join(root, 'config.yaml'))) throw new Error('실리태번 설치 경로와 사용자 이름을 확인해 주세요.');
const userDir = path.join(root, 'data', user);
if (!fs.existsSync(userDir)) throw new Error('사용자 폴더가 없습니다. 실제 사용자 이름을 두 번째 인수로 넣어 주세요. 커스텀 data 경로는 수동 설치가 필요합니다.');
const targets = [path.join(root, 'plugins', 'Silly-Pop-AND'), path.join(userDir, 'extensions', 'Silly-Pop-AND')];
for (const [i, target] of targets.entries()) {
    if (!fs.existsSync(target)) continue;
    if (fs.lstatSync(target).isSymbolicLink()) throw new Error('기존 대상이 심볼릭 링크입니다. 자동으로 덮어쓰지 않습니다.');
    let metadata;
    try { metadata = JSON.parse(fs.readFileSync(path.join(target, i === 0 ? 'package.json' : 'manifest.json'), 'utf8')); } catch { /* Refuse below. */ }
    const owned = i === 0
        ? ['silly-pop-and'].includes(metadata?.name)
        : ['https://github.com/foreverharibo-boop/Silly-Pop/tree/and'].includes(metadata?.homePage);
    if (!owned) throw new Error('대상 폴더가 Silly-Pop AND 설치본이 아닙니다. 덮어쓰지 않습니다.');
}
const stage = fs.mkdtempSync(path.join(root, '.silly-pop-and-install-'));
const installed = [], backups = [];
try {
    fs.mkdirSync(path.join(stage, 'plugin'));
    for (const file of ['package.json', 'package-lock.json', 'LICENSE']) fs.copyFileSync(path.join(__dirname, file), path.join(stage, 'plugin', file));
    fs.cpSync(path.join(__dirname, 'server'), path.join(stage, 'plugin', 'server'), { recursive: true });
    fs.cpSync(path.join(__dirname, 'extension'), path.join(stage, 'extension'), { recursive: true });
    fs.copyFileSync(path.join(__dirname, 'LICENSE'), path.join(stage, 'extension', 'LICENSE'));
    execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: path.join(stage, 'plugin'), stdio: 'inherit', shell: process.platform === 'win32' });
    const backupRoot = path.join(root, '.silly-pop-and-backups', String(Date.now()));
    for (const [i, target] of targets.entries()) {
        const name = i === 0 ? 'plugin' : 'extension';
        fs.mkdirSync(path.dirname(target), { recursive: true });
        if (fs.existsSync(target)) {
            fs.mkdirSync(backupRoot, { recursive: true });
            const backup = path.join(backupRoot, name);
            fs.renameSync(target, backup); backups.push({ target, backup });
        }
        fs.renameSync(path.join(stage, name), target); installed.push(target);
    }
    console.log('Silly-Pop AND 1.0.0 설치 완료. 실리 서버를 다시 시작해 주세요.');
    console.log('기존 실리팝, 릴레이, 채팅 및 config.yaml은 변경하지 않았습니다.');
    if (backups.length) console.log('이전 버전 백업: ' + backupRoot);
} catch (e) {
    for (const target of installed.reverse()) fs.rmSync(target, { recursive: true, force: true });
    for (const { target, backup } of backups.reverse()) fs.renameSync(backup, target);
    throw e;
} finally { fs.rmSync(stage, { recursive: true, force: true }); }

