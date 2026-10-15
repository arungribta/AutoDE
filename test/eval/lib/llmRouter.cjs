'use strict';
/**
 * Routes every LLM call AutoDE makes (all of them go through `getLlmAdapter(provider).complete`)
 * through one of three modes:
 *
 * - offline: no LLM. Calls fail, so AutoDE takes its deterministic/template fallbacks — the
 *            baseline that needs no credentials and is identical on every machine.
 * - record:  calls the real adapter and saves each prompt → response to a cassette.
 * - replay:  answers from the cassette; a prompt with no recording fails like offline mode
 *            (counted as a miss, so a drifted prompt is visible in the report, never hidden).
 *
 * The cassette key hashes provider, model, system prompt, prompt and history, so any change to
 * what AutoDE sends is a miss rather than a stale answer.
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

class LlmRouter {
  constructor({ mode, provider, cassetteDir }) {
    this.mode = mode;
    this.provider = provider;
    this.cassettePath = cassetteDir ? path.join(cassetteDir, `${provider}.jsonl`) : undefined;
    this.cassette = new Map();
    this.stats = { calls: 0, hits: 0, misses: 0, recorded: 0, failures: 0 };
    if (mode === 'replay' && this.cassettePath && fs.existsSync(this.cassettePath)) {
      for (const line of fs.readFileSync(this.cassettePath, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        const entry = JSON.parse(line);
        this.cassette.set(entry.key, entry.response);
      }
    }
  }

  key(prompt, opts) {
    const material = JSON.stringify({ provider: this.provider, model: opts?.model ?? null, system: opts?.systemPrompt ?? null, prompt, history: opts?.history ?? null });
    return crypto.createHash('sha256').update(material).digest('hex');
  }

  /** Wraps the provider's adapter in AutoDE's own adapter registry (same module instance AgentHub uses). */
  install(llmProvidersModule) {
    const adapters = llmProvidersModule.LLM_ADAPTERS;
    const real = adapters[this.provider];
    if (!real) throw new Error(`Unknown LLM provider "${this.provider}".`);
    const router = this;
    adapters[this.provider] = Object.assign(Object.create(Object.getPrototypeOf(real)), real, {
      async complete(prompt, opts, ctx) {
        router.stats.calls++;
        const key = router.key(prompt, opts);
        if (router.mode === 'offline') {
          router.stats.failures++;
          throw new Error('LLM disabled (eval offline mode).');
        }
        if (router.mode === 'replay') {
          if (router.cassette.has(key)) { router.stats.hits++; return router.cassette.get(key); }
          router.stats.misses++;
          throw new Error('No cassette recording for this prompt (eval replay mode).');
        }
        const response = await real.complete(prompt, opts, ctx);
        router.stats.recorded++;
        if (router.cassettePath) {
          fs.mkdirSync(path.dirname(router.cassettePath), { recursive: true });
          fs.appendFileSync(router.cassettePath, JSON.stringify({ key, promptPreview: String(prompt).slice(0, 160), response }) + '\n');
        }
        return response;
      }
    });
  }
}

module.exports = { LlmRouter };
