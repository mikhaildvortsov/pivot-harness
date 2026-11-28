import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

const root = process.env.PIVOT_TEST_ROOT ?? process.cwd();
const { default: registerRouter } = await import(pathToFileURL(join(root, 'ext/router.ts')));
const allowed = ['deepseek/deepseek-v4.1-flash-1017', 'deepseek/deepseek-v4.1-flash-1017:thinking', 'z-ai/glm-5.3-flash'];

test('NanoGPT catalog contains only the selected DeepSeek and GLM models', () => {
  const config = JSON.parse(readFileSync(join(root, 'models.json'), 'utf8'));
  assert.deepEqual(config.providers.nanogpt.models.map(model => model.id).sort(), [...allowed].sort());
  for (const [name, provider] of Object.entries(config.providers)) {
    if (name.startsWith('nanogpt')) for (const model of provider.models) assert.match(model.id, /^(deepseek\/|z-ai\/glm)/);
  }
});

test('router cannot select removed Qwen even when it is the only authenticated model', () => {
  let route;
  registerRouter({ events: { on() {} }, registerVirtualModel: definition => { route = definition.route; } });
  const forbidden = { provider: 'nanogpt', id: 'qwen/qwen3-coder-next', input: ['text'] };
  const ctx = { modelRegistry: { find: (provider, id) => provider === forbidden.provider && id === forbidden.id ? forbidden : undefined, hasConfiguredAuth: () => true } };
  for (const thinkingLevel of ['off', 'high']) assert.throws(() => route({ reason: 'initial', messages: [], thinkingLevel }, ctx), /no .*model/);
});

test('doctor excludes disabled NanoGPT models and subscription routes remain configured', () => {
  const doctor = readFileSync(join(root, 'doctor/doctor.mjs'), 'utf8');
  assert.ok(!doctor.includes('qwen/qwen3-coder-next'));
  const settings = JSON.parse(readFileSync(join(root, 'settings.json'), 'utf8'));
  for (const extension of ['ext/quota-fallback.ts', 'ext/opus-director.ts', 'ext/codex-accounts.ts']) assert.ok(settings.extensions.includes(extension), extension);
});
