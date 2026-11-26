import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { loadExtensions } from '/Users/dvortsovmikhail/.npm-global/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js';
import { ExtensionRunner } from '/Users/dvortsovmikhail/.npm-global/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/runner.js';
import { AgentSession } from '/Users/dvortsovmikhail/.npm-global/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js';
import { Agent } from '/Users/dvortsovmikhail/.npm-global/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-agent-core/dist/agent.js';
import { stream } from '/Users/dvortsovmikhail/.npm-global/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/api/openai-completions.js';
import { cacheExtra, report } from '../ext/cost-watch.ts';
import { meteredEstimate } from '../ext/task-budget.ts';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('..', import.meta.url));
const model = { api: 'openai-completions', provider: 'fixture', id: 'fixture', name: 'fixture', baseUrl: 'https://fixture.invalid/v1', reasoning: false, input: ['text'], contextWindow: 10000, maxTokens: 100, cost: { input: 260000, output: 0, cacheRead: 0, cacheWrite: 0 } };
const preview = () => ({ contextEntries: [], contextMessages: [], llmMessages: [], pendingMessages: [], canContinue: true });
async function setup(mode, oauth = false) {
    const loaded = await loadExtensions([`${root}/ext/cost-watch.ts`, `${root}/ext/auto-verify.ts`], root);
    assert.deepEqual(loaded.errors, []);
    const notes = [], errors = [];
    let requests = 0, completed = 0, agent;
    const registry = { find: (provider, id) => ({ ...model, provider, id }), isUsingOAuth: () => oauth };
    const runner = new ExtensionRunner(loaded.extensions, loaded.runtime, root, { getBranch: () => [] }, registry);
    runner.onError(e => errors.push(e));
    runner.bindCore({}, { getModel: () => model, getScopedModels: () => [], isIdle: () => !agent?.state.isStreaming, isProjectTrusted: () => true, getSignal: () => agent?.signal, abort: () => agent.abort(), hasPendingMessages: () => false, getContextUsage: () => undefined, getSystemPrompt: () => '' });
    runner.setUIContext({ ...runner.getUIContext(), notify: (...args) => notes.push(args) }, mode);
    const fetch = async () => { requests++; const chunk = { id: 'fixture', object: 'chat.completion.chunk', created: 0, model: 'fixture', choices: [{ index: 0, delta: requests === 1 ? { role: 'assistant', tool_calls: [{ index: 0, id: 'a', type: 'function', function: { name: 'fixture_write', arguments: '{}' } }, { index: 1, id: 'b', type: 'function', function: { name: 'fixture_write', arguments: '{}' } }] } : { role: 'assistant', content: 'done' }, finish_reason: requests === 1 ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 0, total_tokens: 1 } }; return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } }); };
    agent = new Agent({ initialState: { model, tools: [{ name: 'fixture_write', label: 'Fixture', description: 'offline test', parameters: { type: 'object', properties: {} }, execute: async () => { await delay(3); completed++; return { content: [{ type: 'text', text: 'ok' }] }; } }] }, streamFn: (m, c, o) => stream(m, c, { ...o, apiKey: 'fabricated-fixture', fetch, maxRetries: 0 }), transformContext: m => runner.emitContext(m), onPayload: p => runner.emitBeforeProviderRequest(p), finishTurn: async (turn) => { await runner.emitBoundary({ type: 'turn_end', turnIndex: 0, message: turn.message, toolResults: turn.toolResults, messageEntryId: 'm', toolResultEntryIds: [], outcome: 'completed' }, preview); } });
    agent.subscribe(async (event) => { if (event.type === 'message_end')
        await runner.emitMessageEnd(event); if (event.type === 'agent_end')
        await runner.emit(event); });
    const command = args => AgentSession.prototype._tryExecuteExtensionCommand.call({ _extensionRunner: runner }, `/budget ${args}`);
    await runner.emitInput('fixture', undefined, 'interactive');
    return { runner, notes, errors, agent, command, requests: () => requests, completed: () => completed };
}
const threshold = await setup('tui');
const charge = total => threshold.runner.emitMessageEnd({
    type: 'message_end',
    message: {role: 'assistant', provider: 'fixture', model: 'fixture', content: [], usage: {input: 1, cost: {total}}}
});
await charge(0.099);
assert.equal(threshold.notes.length, 0, 'no warning below $0.10');
await charge(0.001);
assert.equal(threshold.notes.length, 1, 'warning starts at $0.10');
await threshold.runner.emitContext([]);
await charge(0.15);
let crossed = false;
const blocked = threshold.runner.emitContext([]).then(() => { crossed = true; });
await delay(20);
assert.equal(crossed, false, 'pause starts at $0.25');
await threshold.command('increase 0.50');
await blocked;
assert.equal(crossed, true);
const run = await setup('tui');
const pending = run.agent.prompt('fabricated task');
await delay(180);
assert.equal(run.requests(), 1);
assert.equal(run.completed(), 2, 'whole write batch completes before pause');
assert.ok(run.notes.some(([s]) => s.includes('Paused.')));
await run.runner.emitInput('automatic continuation', undefined, 'extension');
assert.equal((await run.runner.emitInput('retry task', undefined, 'interactive')).action, 'handled');
await run.command('bad');
await delay(20);
assert.equal(run.requests(), 1);
await run.command('continue');
await pending;
assert.equal(run.requests(), 2, 'real command dispatch resumes same installed Agent loop');
assert.deepEqual(run.errors, []);
for (const mode of ['print', 'json']) {
    const r = await setup(mode);
    await Promise.race([r.agent.prompt('fixture'), delay(1500).then(() => { throw Error(`${mode} hung`); })]);
    assert.equal(r.completed(), 2);
    assert.equal(r.requests(), 1, `${mode} abort signal prevents second HTTP request`);
    assert.deepEqual(r.errors, []);
}
const cancelled = await setup('rpc');
const waiting = cancelled.agent.prompt('fixture');
await delay(120);
cancelled.agent.abort();
await waiting;
assert.equal(cancelled.requests(), 1, 'abort releases gate without a new HTTP request');
for (const oauth of [false, true]) {
    const auth = await setup('tui', oauth);
    await auth.runner.emitMessageEnd({ type: 'message_end', message: { role: 'assistant', provider: 'anthropic', model: 'fixture', content: [], usage: { input: 1, cost: { total: .25 } } } });
    await auth.command('');
    assert.ok(auth.notes.some(([text]) => text.includes(oauth ? '$0.000 /' : '$0.250 /')), 'OAuth subscription is excluded; API-key Anthropic is metered');
    assert.deepEqual(auth.errors, []);
}
assert.equal(meteredEstimate('anthropic', 9, true), 0);
assert.equal(meteredEstimate('openai-codex', 9, true), 0);
assert.equal(meteredEstimate('anthropic', 9, false), 9);
assert.equal(meteredEstimate('openai-codex', 9, false), 9);
assert.equal(meteredEstimate('fixture', 9, true), 9);
assert.equal(meteredEstimate('fixture', .15), .15);
assert.equal(meteredEstimate('fixture', NaN), 0);
assert.equal(cacheExtra({ input: 100, cacheRead: 100, cost: { input: .1, cacheRead: .02 } }), .08);
assert.equal(cacheExtra({ input: 100, cost: { input: .1 } }), undefined);
assert.equal(cacheExtra({input:100,cacheRead:100,cost:{input:.1}}),undefined);
assert.match(report([{ type: 'message', message: { role: 'assistant', provider: 'fixture', model: 'fixture', usage: { input: 1, cost: { total: .1 } } } }], { system: 0, tools: 0, toolCount: 0 }), /не счёт провайдера/);
console.log('PASS: installed loader/runner, Agent core and real OpenAI transport with offline fetch; batch completion, pause, command resume, print/JSON termination, abort, subscription exclusion, cache estimate.');
