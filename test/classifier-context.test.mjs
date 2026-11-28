import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import test from 'node:test';

const globalRoot = execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim();
const requirePi = createRequire(join(globalRoot, '@earendil-works/pi-coding-agent/package.json'));
const { createJiti } = requirePi('jiti');
const jiti = createJiti(import.meta.url, { alias: { typebox: requirePi.resolve('typebox') }, moduleCache: false });
const root = process.env.PIVOT_TEST_ROOT ?? process.cwd();
const { default: classifier } = await jiti.import(join(root, 'ext/task-classifier.ts'));
// The published base and active harness have different pre-existing verifier contracts.
const active = process.env.PIVOT_TEST_CONTRACT === 'active';
const contract = active ? { model: 'openai-codex/gpt-6.1-sol', timeout: 45000, child: 'PI_DOCTOR=1', attempts: 2 } : { model: 'anthropic/claude-sonnet-5-5', timeout: 90000, child: 'PI_WATCHDOG_MAINTAINER=1', attempts: 1 };
const proposal = { kind: 'code', fullstack: false, security: false, subtasks: 1, use_skills: false, spec_mode: 'none', summary: 'fabricated change' };

function setup(replies = [], auth = true) {
  const handlers = new Map(), tools = [], calls = [], levels = [];
  classifier({
    on: (name, fn) => handlers.set(name, fn),
    registerTool: (tool) => tools.push(tool),
    events: { emit() {} },
    getThinkingLevel: () => 'low', setThinkingLevel: (level) => levels.push(level),
    exec: async (...args) => { calls.push(args); return replies.shift() ?? { code: 1, stdout: '' }; },
  });
  const ctx = { cwd: '/fabricated/project', modelRegistry: { find: () => ({ id: 'fabricated' }), hasConfiguredAuth: () => auth } };
  const classify = async (p = proposal) => tools[0].execute('fixture', p, undefined, undefined, ctx);
  return { handlers, calls, levels, classify };
}
const reply = (value) => ({ code: 0, stdout: JSON.stringify(value) });

test('verifier argv isolates discovery while preserving request, proposal and execution contract', async () => {
  const s = setup([reply(proposal)]);
  await s.handlers.get('before_agent_start')({ messageType: 'user', prompt: 'fabricated request' });
  await s.classify();
  assert.equal(s.calls.length, 1);
  const [command, args, options] = s.calls[0];
  assert.equal(command, 'env');
  for (const flag of ['--no-skills', '--no-context-files', '-ne', '--no-session', '--no-tools', '-p', 'PI_OPUS_CHILD=1', 'PI_SUBAGENT_CHILD=1', contract.child, process.execPath]) assert.ok(args.includes(flag), flag);
  assert.equal(args[args.indexOf('--model') + 1], contract.model);
  assert.equal(args[args.indexOf('--thinking') + 1], 'medium');
  assert.deepEqual(options, { cwd: '/fabricated/project', timeout: contract.timeout });
  assert.match(args.at(-1), /USER REQUEST:\nfabricated request/);
  assert.ok(args.at(-1).includes(`PROPOSED:\n${JSON.stringify(proposal)}`));
  assert.match(args.at(-1), /ONLY one JSON object/);
  assert.deepEqual(s.levels, ['off', active ? 'off' : 'low']);
});

test('security OR preserves proposed security and promotes verifier security', async () => {
  for (const [proposed, verified] of [[true, false], [false, true]]) {
    const s = setup([reply({ ...proposal, security: verified })]);
    assert.equal((await s.classify({ ...proposal, security: proposed })).details.security, true);
  }
});

test('user thinking ceiling caps security effort and restores on settlement', async () => {
  const s = setup([reply({ ...proposal, security: true })]);
  await s.handlers.get('before_agent_start')({ messageType: 'user', prompt: 'fabricated security change' });
  await s.classify();
  assert.deepEqual(s.levels, ['off', 'low']);
  await s.handlers.get('agent_settled')();
  assert.deepEqual(s.levels, ['off', 'low', 'low']);
});

test('failed, missing JSON and malformed JSON replies retain proposal', async () => {
  for (const bad of [{ code: 1, stdout: '' }, { code: 0, stdout: 'no JSON' }, { code: 0, stdout: '{invalid}' }]) {
    const s = setup([bad, bad]);
    const r = await s.classify();
    for (const [key, value] of Object.entries(proposal)) assert.equal(r.details[key], value);
    assert.equal(s.calls.length, bad.stdout === '{invalid}' ? 1 : contract.attempts);
  }
});

test('write/edit gate resets per input and permits other tools', async () => {
  const s = setup([reply(proposal)]);
  const gate = s.handlers.get('tool_call');
  for (const toolName of ['write', 'edit']) assert.equal((await gate({ toolName })).block, true);
  assert.equal(await gate({ toolName: 'read' }), undefined);
  await s.classify();
  assert.equal(await gate({ toolName: 'write' }), undefined);
  await s.handlers.get('input')();
  assert.equal((await gate({ toolName: 'edit' })).block, true);
});

if (active) {
  test('active verifier skips unauthenticated subprocess and retains proposal', async () => {
    const s = setup([], false);
    assert.equal((await s.classify()).details.kind, proposal.kind);
    assert.equal(s.calls.length, 0);
  });
  test('active verifier retries once and accepts second reply', async () => {
    const s = setup([{ code: 1, stdout: '' }, reply({ ...proposal, security: true })]);
    assert.equal((await s.classify()).details.security, true);
    assert.equal(s.calls.length, 2);
  });
}
