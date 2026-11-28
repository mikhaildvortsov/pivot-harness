import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import os from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test, { mock } from 'node:test';

const globalRoot = execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim();
const { loadExtensions } = await import(pathToFileURL(join(globalRoot, '@earendil-works/pi-coding-agent/dist/core/extensions/loader.js')));
const extension = join(process.env.PIVOT_TEST_ROOT ?? process.cwd(), 'ext/output-trim.ts');
const fixture = mkdtempSync(join(tmpdir(), 'pivot-output-test-'));
const oldTmp = process.env.TMPDIR;
test.after(() => { if (oldTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = oldTmp; rmSync(fixture, { recursive: true }); });

async function hook() {
  const r = await loadExtensions([extension], process.cwd());
  assert.deepEqual(r.errors, []);
  return r.extensions[0].handlers.get('tool_result')[0];
}
const event = (text, command = 'npm test') => ({ toolName: 'bash', input: { command }, content: [{ type: 'text', text }] });

test('ordinary output, other tools, and multiple blocks pass through', async () => {
  process.env.TMPDIR = fixture;
  const run = await hook();
  for (const size of [0, 9000]) assert.equal(await run(event('x'.repeat(size))), undefined);
  assert.equal(await run(event('x'.repeat(24000), 'cat file')), undefined);
  assert.equal(await run({ ...event('x'.repeat(30000)), toolName: 'read' }), undefined);
  assert.equal(await run({ ...event('x'.repeat(30000)), content: [{ type: 'text', text: 'x'.repeat(30000) }, { type: 'text', text: 'extra' }] }), undefined);
});

const cases = [
  ['one line', 'x'.repeat(9001), 'npm test', 9000],
  ['170 lines', Array(170).fill('x'.repeat(100)).join('\n'), 'npm test', 9000],
  ['171 lines', Array(171).fill('x'.repeat(100)).join('\n'), 'npm test', 9000],
  ['reading boundary', 'x'.repeat(24001), 'cat file', 24000],
  ['unicode', '🧪'.repeat(16000), 'npm test', 9000],
  ['head tail error', ['HEAD evidence ' + 'h'.repeat(20000), ...Array(60).fill('normal'), 'ERROR evidence ' + 'e'.repeat(20000), ...Array(160).fill('normal'), 'TAIL evidence ' + 't'.repeat(20000)].join('\n'), 'npm test', 9000],
];
for (const [name, text, command, limit] of cases) test(name, async () => {
  process.env.TMPDIR = fixture;
  const result = await (await hook())(event(text, command));
  assert.ok(result, 'oversized output must be bounded');
  const preview = result.content[0].text;
  assert.ok(preview.length <= limit, `${preview.length} > ${limit}`);
  assert.match(preview, /omitted/);
  const path = preview.match(/full output: ([^\n;]+\.txt)/)?.[1];
  assert.ok(path, 'recoverable artifact pointer');
  assert.equal(readFileSync(path, 'utf8'), text);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  if (name === 'head tail error') for (const evidence of ['HEAD evidence', 'TAIL evidence', 'ERROR evidence']) assert.ok(preview.includes(evidence), evidence);
  console.log(`${name}: ${text.length} -> ${preview.length} UTF-16 code units`);
});

test('artifact creation is unique across extension instances', async () => {
  process.env.TMPDIR = fixture;
  const a = await (await hook())(event('a'.repeat(30000)));
  const b = await (await hook())(event('b'.repeat(30000)));
  const path = (r) => r?.content[0].text.match(/full output: ([^\n;]+\.txt)/)?.[1];
  assert.ok(path(a)); assert.ok(path(b)); assert.notEqual(path(a), path(b));
  assert.equal(readFileSync(path(a), 'utf8'), 'a'.repeat(30000));
});

test('artifact storage failure preserves original output', async () => {
  const blocked = join(fixture, 'not-a-directory');
  writeFileSync(blocked, 'fixture');
  process.env.TMPDIR = blocked;
  const e = event('x'.repeat(30000));
  assert.equal(await (await hook())(e), undefined);
  assert.equal(e.content[0].text, 'x'.repeat(30000));
});

test('artifact write failure preserves original output', async () => {
  process.env.TMPDIR = fixture;
  const run = await hook();
  const write = mock.method(fs, 'writeFileSync', () => { throw new Error('fabricated write failure'); });
  syncBuiltinESMExports();
  try {
    const e = event('x'.repeat(30000));
    assert.equal(await run(e), undefined);
    assert.equal(e.content[0].text, 'x'.repeat(30000));
    assert.equal(write.mock.callCount(), 1);
  } finally { write.mock.restore(); syncBuiltinESMExports(); }
});

test('long artifact path and many line labels remain inside total preview budget', async () => {
  const rows = Array(1_000_000).fill('');
  for (let i = 0; i < 40; i++) rows[i] = 'HEAD evidence ' + 'x'.repeat(1000);
  for (let i = 500000; i < 500040; i++) rows[i] = 'ERROR evidence ' + 'y'.repeat(1000);
  rows[rows.length - 1] = 'TAIL evidence';
  const text = rows.join('\n');
  const saved = [];
  const mocks = [
    mock.method(os, 'tmpdir', () => '/tmp/' + 'a/'.repeat(1950)),
    mock.method(fs, 'mkdirSync', () => undefined),
    mock.method(fs, 'writeFileSync', (...args) => saved.push(args)),
  ];
  syncBuiltinESMExports();
  try {
    const result = await (await hook())(event(text));
    const preview = result.content[0].text;
    assert.ok(preview.length <= 9000, `${preview.length} > 9000`);
    assert.equal(saved.length, 1);
    assert.equal(saved[0][1], text);
    assert.ok(preview.includes(`full output: ${saved[0][0]};`));
    assert.deepEqual(saved[0][2], { flag: 'wx', mode: 0o600 });
    for (const evidence of ['HEAD evidence', 'ERROR evidence', 'TAIL evidence']) assert.ok(preview.includes(evidence), evidence);
  } finally { for (const m of mocks) m.mock.restore(); syncBuiltinESMExports(); }
});
