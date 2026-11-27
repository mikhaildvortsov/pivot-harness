// Run: node --test test/thinking-effort.test.mjs (requires the installed pi CLI).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('..', import.meta.url));
const piRoot = process.env.PI_PACKAGE_ROOT ?? join(execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim(), '@earendil-works/pi-coding-agent');
const { loadExtensions } = await import(pathToFileURL(join(piRoot, 'dist/core/extensions/loader.js')).href);
const { providers } = JSON.parse(readFileSync(join(root, 'models.json'), 'utf8'));
const models = Object.entries(providers).flatMap(([provider, config]) => config.models.map(model => ({
    ...model, provider, api: config.api, baseUrl: 'https://fixture.invalid/v1',
    compat: { ...config.compat, ...model.compat },
})));
const loaded = await loadExtensions(['router', 'nanogpt-guard'].map(name => join(root, 'ext', `${name}.ts`)), root);
assert.deepEqual(loaded.errors, []);
let excluded = new Set();
loaded.runtime.createContext = () => ({ modelRegistry: {
    find: (provider, id) => models.find(model => model.provider === provider && model.id === id),
    hasConfiguredAuth: model => !excluded.has(model.provider),
} });
const route = loaded.runtime.pendingVirtualModelRegistrations.find(entry => entry.definition.provider === 'router').definition.route;
const transport = loaded.runtime.pendingProviderRegistrations.find(entry => entry.name === 'nanogpt').config;
const initial = { reason: 'initial', messages: [], thinkingLevel: 'off' };

test('Thinking requests preserve distinct low and high effort through the installed transport', async () => {
    const originalFetch = globalThis.fetch;
    const bodies = [];
    globalThis.fetch = async (url, request) => {
        assert.equal(new URL(url).hostname, 'fixture.invalid');
        bodies.push(JSON.parse(request.body));
        const chunk = { id: 'fixture', choices: [{ index: 0, delta: { content: 'OK' }, finish_reason: 'stop' }] };
        return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
    };
    try {
        for (const thinkingLevel of ['off', 'low', 'high']) {
            const selected = route({ ...initial, thinkingLevel });
            const events = [];
            for await (const event of transport.streamSimple(selected.model, {
                messages: [{ role: 'user', content: 'Synthetic effort test', timestamp: 0 }],
            }, { apiKey: 'fabricated-fixture', reasoning: selected.thinkingLevel, maxRetries: 0 })) events.push(event);
            assert.ok(events.some(event => event.type === 'done'), JSON.stringify(events.filter(event => event.type === 'error')));
        }
        assert.deepEqual(bodies.map(body => body.reasoning_effort), [undefined, 'low', 'high']);
        assert.ok(!bodies[0].model.endsWith(':thinking'));
        assert.ok(bodies.slice(1).every(body => body.model.endsWith(':thinking')));
    } finally { globalThis.fetch = originalFetch; }
});

test('continuations apply the current effort without changing the Thinking model', () => {
    const low = route({ ...initial, thinkingLevel: 'low' });
    const high = route({ ...initial, reason: 'continuation', thinkingLevel: 'high', previous: low });
    assert.equal(high.model.id, low.model.id);
    assert.equal(high.thinkingLevel, 'high');
    assert.equal(route({ ...initial, reason: 'continuation', thinkingLevel: 'low', previous: high }).thinkingLevel, 'low');
});

test('turning thinking on or off selects the matching model on continuation', () => {
    const plain = route(initial);
    const thinking = route({ ...initial, reason: 'continuation', thinkingLevel: 'high', previous: plain });
    assert.ok(thinking.model.id.endsWith(':thinking'));
    assert.equal(route({ ...initial, reason: 'continuation', previous: thinking }).model.id, plain.model.id);
});

test('direct plain calls and vision paths remain without requested reasoning', () => {
    assert.equal(route({ ...initial, reason: 'direct', thinkingLevel: 'high' }).thinkingLevel, 'off');
    const vision = route({ ...initial, thinkingLevel: 'high', messages: [{ role: 'user', content: [{ type: 'image' }] }] });
    assert.match(vision.model.id, /glm/i);
    assert.equal(vision.thinkingLevel, 'off');
});

test('retrying the Thinking model keeps its selected effort', () => {
    const high = route({ ...initial, thinkingLevel: 'high' });
    const retry = route({ ...initial, thinkingLevel: 'high', reason: 'retry', failed: {
        model: high.model, thinkingLevel: high.thinkingLevel, message: { errorMessage: 'invalid synthetic request' },
    } });
    assert.equal(retry.model.id, high.model.id);
    assert.equal(retry.thinkingLevel, 'high');
});

test('Gonka fallback preserves DeepSeek effort and keeps GLM thinking off', () => {
    excluded = new Set(['nanogpt']);
    try {
        assert.equal(route({ ...initial, thinkingLevel: 'high' }).thinkingLevel, 'high');
        const vision = route({ ...initial, thinkingLevel: 'high', messages: [{ role: 'user', content: [{ type: 'image' }] }] });
        assert.equal(vision.model.provider, 'gonka');
        assert.equal(vision.thinkingLevel, 'off');
    } finally { excluded = new Set(); }
});
