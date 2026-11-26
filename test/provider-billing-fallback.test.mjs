import assert from 'node:assert/strict';
import nanoGuard from '../ext/nanogpt-guard.ts';
import router from '../ext/router.ts';

function fixture(available = ['nanogpt', 'gonka']) {
    const listeners = new Map(), providers = new Map(), down = [];
    let route;
    const model = (provider, id) => ({ provider, id, api: 'openai-completions', name: id, baseUrl: 'https://fixture.invalid/v1', input: ['text'], reasoning: false, contextWindow: 10000, maxTokens: 16, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } });
    const models = [model('nanogpt', 'deepseek/deepseek-v4.1-flash-1017'), model('nanogpt', 'qwen/qwen3-coder-next'), model('gonka', 'deepseek-ai/DeepSeek-V4-Flash-0731'), model('gonka', 'zai-org/GLM-5.3-Flash')];
    const pi = {
        on() {},
        registerProvider: (name, definition) => providers.set(name, definition),
        registerVirtualModel: definition => { route = definition.route; },
        events: {
            on: (name, handler) => listeners.set(name, handler),
            emit: (name, data) => { if (name === 'provider:down') down.push(data); listeners.get(name)?.(data); },
        },
    };
    router(pi);
    nanoGuard(pi);
    const ctx = { modelRegistry: { find: (p, id) => models.find(m => m.provider === p && m.id === id), hasConfiguredAuth: m => available.includes(m.provider) } };
    const initial = { reason: 'initial', messages: [], thinkingLevel: 'off' };
    return { providers, down, initial, pick: request => route(request, ctx) };
}

const run = fixture();
const first = run.pick(run.initial);
let requests = 0;
const originalFetch = globalThis.fetch;
try {
    globalThis.fetch = async () => {
        requests++;
        return new Response(JSON.stringify({ error: { message: 'Billing reservation failed' } }), { status: 503, headers: { 'content-type': 'application/json' } });
    };
    const events = [];
    for await (const event of run.providers.get('nanogpt').streamSimple(first.model, { messages: [] }, { apiKey: 'fabricated-fixture', maxRetries: 0 })) events.push(event);
    const error = events.find(event => event.type === 'error')?.error;
    assert.ok(error, 'the installed OpenAI-compatible transport reports the synthetic 503');
    assert.equal(requests, 1, 'no hidden provider retries');
    assert.equal(run.down.length, 1, 'billing reservation failure benches the entire provider');
    assert.equal(run.down[0].provider, 'nanogpt');
    assert.match(error.errorMessage, /switching to (?:the )?reserve provider/);
    const next = run.pick({ ...run.initial, reason: 'retry', failed: { model: first.model, message: error } });
    assert.equal(next.model.provider, 'gonka');
} finally { globalThis.fetch = originalFetch; }

const now = Date.now;
try {
    // The router intentionally shares provider cooldowns across registrations.
    Date.now = () => now() + 2 * 60 * 60 * 1000;
    const raw = fixture();
    const before = raw.pick(raw.initial);
    assert.equal(raw.pick({ ...raw.initial, reason: 'retry', failed: { model: before.model, message: { errorMessage: 'Billing reservation failed' } } }).model.provider, 'gonka', 'the message without an HTTP prefix also triggers provider failover');
    Date.now = () => now() + 4 * 60 * 60 * 1000;
    const noReserve = fixture(['nanogpt']);
    const start = noReserve.pick(noReserve.initial);
    assert.throws(() => noReserve.pick({ ...noReserve.initial, reason: 'retry', failed: { model: start.model, message: { errorMessage: '503 Billing reservation failed' } } }), /no authenticated, unbenched model/, 'do not try Qwen on the same failed billing account');
} finally { Date.now = now; }
console.log('PASS: synthetic 503 through installed provider transport; whole-provider billing failover; raw message handling; no same-account fallback. No live requests.');
