import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import install from '../ext/auto-verify.ts';
const root = mkdtempSync(join(tmpdir(), 'pi-verify-fixture-'));
writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { typecheck: 'fixture', lint: 'fixture' } }));
const handlers = new Map(), results = [], notes = [];
let checks = 0, tree = 'before', fail = true;
install({ on: (name, fn) => handlers.set(name, fn), events: { emit: (name, result) => results.push(result) }, exec: async (cmd, args) => {
        if (cmd === 'git' && args[0] === 'rev-parse')
            return { code: 0, stdout: root, stderr: '' };
        if (cmd === 'git')
            return { code: 0, stdout: ' M index.ts\n', stderr: '' };
        if (args[0] === '-c')
            return { code: 0, stdout: tree, stderr: '' };
        checks++;
        return { code: fail ? 1 : 0, stdout: fail ? 'fixture error TS1000' : '', stderr: '' };
    } });
const ctx = { cwd: root, ui: { notify: (...args) => notes.push(args) } };
const settle = () => handlers.get('agent_before_settle')({ outcome: 'completed', entries: [] }, ctx);
await handlers.get('input')({ source: 'interactive' }, ctx);
await handlers.get('agent_start')({}, ctx);
tree = 'after';
assert.equal((await settle()).continue, true);
assert.equal(checks, 2);
await handlers.get('input')({ source: 'extension' }, ctx);
const stopped = await settle();
assert.equal(checks, 4, 'both required checks rerun on second attempt');
assert.equal(stopped.continue, false);
assert.match(stopped.entries[0].content, /UNRESOLVED required checks/);
assert.match(stopped.entries[0].content, /Do not report success/);
await settle();
assert.equal(checks, 4, 'halted repair cannot loop');
assert.equal(results.filter(r => r.status === 'fail').length, 4);
await handlers.get('input')({ source: 'interactive' }, ctx);
assert.equal((await settle()).continue, true, 'explicit new user task resets retry state');
assert.equal(checks, 6);
fail = false;
assert.equal(await settle(), undefined);
assert.equal(checks, 8);
assert.equal(results.filter(r => r.status === 'pass').length, 2);
console.log('PASS: both required checks retained; stop after two identical failed attempts; persistent unresolved context; no loop or extension-input reset; explicit user reset and successful recheck.');
