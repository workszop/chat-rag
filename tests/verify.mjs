#!/usr/bin/env node
// Agent-native verification for index.html. Usage: node tests/verify.mjs [name-filter]
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// ─── Constants ───
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const INDEX = resolve(ROOT, 'index.html');
const PAGE_URL = pathToFileURL(INDEX).href;
const PLAYWRIGHT = process.env.PLAYWRIGHT_MODULE || '/home/andrzey/.hermes/hermes-agent/node_modules/playwright/index.mjs';
const CHROME = process.env.CHROME_BIN || '/usr/bin/google-chrome';
const DESKTOP = { width: 1440, height: 900 };
const MOBILE = { width: 390, height: 844 };
const INK_MARK_MD5 = '4ea612c70d05293a1536543d6e363a40';
const ENGLISH_MARKERS = ['Next', 'Reset', 'Run Demo', 'Query', 'Cost Summary', 'tokens in', 'Chat AI', 'Agentic AI', 'Best choice', 'Answer'];

// ─── Harness ───
const probes = [];
const probe = (name, fn, opts = {}) => probes.push({ name, fn, opts });
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };
const appState = page => page.evaluate(() => ({ ...document.getElementById('app').dataset }));
const press = async (page, key, times = 1) => { for (let i = 0; i < times; i++) await page.keyboard.press(key); };

// ─── Probes ───
probe('contract: root publishes initial state', async page => {
  const s = await appState(page);
  assert(s.lang === 'pl' && s.scenario === 'general' && s.step === '0' && s.status === 'idle' && s.playing === 'false', `unexpected state ${JSON.stringify(s)}`);
});

probe('i18n: pl and en have the same key structure', async page => {
  const same = await page.evaluate(() => {
    const shape = v => Array.isArray(v) ? v.map(shape) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, shape(v[k])])) : typeof v;
    return JSON.stringify(shape(T.pl)) === JSON.stringify(shape(T.en));
  });
  assert(same, 'T.pl and T.en differ in structure');
});
probe('i18n: no em-dash in strings or rendered page', async page => {
  const found = await page.evaluate(() => JSON.stringify(T).includes('\u2014') || document.body.innerText.includes('\u2014'));
  assert(!found, 'em-dash found');
});
probe('i18n: Polish UI has no English leftovers', async page => {
  for (const key of ['1', '2', '3']) {
    await page.keyboard.press(key);
    await press(page, 'ArrowRight', 5);
    const text = await page.evaluate(() => document.body.innerText);
    const hits = ENGLISH_MARKERS.filter(w => text.includes(w));
    assert(hits.length === 0, `scenario ${key}: ${hits.join(', ')}`);
  }
});
probe('i18n: L switches to English and the choice survives reload', async page => {
  await page.keyboard.press('l');
  assert((await appState(page)).lang === 'en', 'L did not switch to en');
  assert(await page.evaluate(() => document.documentElement.lang) === 'en', 'html lang not updated');
  await page.reload();
  await page.waitForFunction(() => document.getElementById('app')?.dataset.status);
  assert((await appState(page)).lang === 'en', 'language not persisted');
});
probe('i18n: blocked localStorage still boots in Polish', async page => {
  assert((await appState(page)).lang === 'pl', 'did not boot in pl');
  await page.keyboard.press('l');
  assert((await appState(page)).lang === 'en', 'toggle failed without storage');
}, { init: () => Object.defineProperty(window, 'localStorage', { get() { throw new Error('blocked'); } }) });
probe('brand: header uses the ink edulab mark', () => {
  const html = readFileSync(INDEX, 'utf8');
  const match = html.match(/class="edu-logo"[^>]*base64,([A-Za-z0-9+/=]+)/);
  assert(match, 'no inline edu-logo');
  const md5 = createHash('md5').update(Buffer.from(match[1], 'base64')).digest('hex');
  assert(md5 === INK_MARK_MD5, `logo md5 ${md5}`);
}, { static: true });

probe('data: every scenario has text for every lane and phase', async page => {
  const missing = await page.evaluate(() => {
    const out = [];
    for (const lang of ['pl', 'en']) for (const id of SCENARIO_IDS) {
      const s = T[lang].scenarios && T[lang].scenarios[id];
      if (!s || !s.question || !s.tab || !s.hint) { out.push(`${lang}/${id}`); continue; }
      for (const lane of LANES) for (const phase of PHASES) {
        const c = s.lanes[lane] && s.lanes[lane][phase];
        if (!c || !c.body || (!['answer', 'verdict'].includes(phase) && !c.title)) out.push(`${lang}/${id}/${lane}/${phase}`);
      }
    }
    return out;
  });
  assert(missing.length === 0, `missing: ${missing.join(', ')}`);
});
probe('data: one best grade per scenario and it is the winner', async page => {
  const bad = await page.evaluate(() => SCENARIO_IDS.filter(id => {
    const m = SCENARIO_META[id];
    const best = LANES.filter(l => m.lanes[l].grade === 'best');
    return best.length !== 1 || best[0] !== m.winner;
  }));
  assert(bad.length === 0, `bad: ${bad}`);
});
probe('data: each approach wins exactly one scenario', async page => {
  const winners = await page.evaluate(() => SCENARIO_IDS.map(id => SCENARIO_META[id].winner).sort().join(','));
  assert(winners === 'agent,chat,rag', `winners ${winners}`);
});
probe('data: chat is cheapest and agent most expensive everywhere', async page => {
  const bad = await page.evaluate(() => SCENARIO_IDS.filter(id => {
    const c = l => SCENARIO_META[id].lanes[l].cost;
    const tok = l => c(l).in + c(l).out;
    return !(tok('chat') < tok('rag') && tok('rag') < tok('agent') && c('chat').seconds < c('rag').seconds && c('rag').seconds < c('agent').seconds);
  }));
  assert(bad.length === 0, `ordering broken in ${bad}`);
});
probe('data: agent loop kinds match loop texts', async page => {
  const bad = await page.evaluate(() => {
    const out = [];
    for (const id of SCENARIO_IDS) {
      const kinds = SCENARIO_META[id].lanes.agent.loop;
      for (const lang of ['pl', 'en']) {
        const texts = T[lang].scenarios[id].lanes.agent.process.loop;
        if (!kinds || !texts || kinds.length !== texts.length || kinds[0] !== 'plan') out.push(`${lang}/${id}`);
      }
    }
    return out;
  });
  assert(bad.length === 0, `loop mismatch: ${bad}`);
});
probe('data: use states are valid and only the agent ever acts', async page => {
  const bad = await page.evaluate(() => {
    const out = [];
    for (const id of SCENARIO_IDS) for (const lane of LANES) {
      const use = SCENARIO_META[id].lanes[lane].use;
      for (const phase of ['source', 'process', 'action']) if (!['used', 'unused', 'unavailable'].includes(use[phase])) out.push(`${id}/${lane}/${phase}`);
      if (lane !== 'agent' && use.action !== 'unavailable') out.push(`${id}/${lane} acts`);
    }
    return out;
  });
  assert(bad.length === 0, bad.join(', '));
});

// ─── Run ───
const filter = process.argv[2] || '';
const selected = probes.filter(p => p.name.includes(filter));
const { chromium } = await import(PLAYWRIGHT);
const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
let failed = 0;
for (const p of selected) {
  try {
    if (p.opts.static) {
      await p.fn();
    } else {
      const context = await browser.newContext({ viewport: p.opts.viewport || DESKTOP });
      if (p.opts.init) await context.addInitScript(p.opts.init);
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', e => errors.push(e.message));
      try {
        await page.goto(PAGE_URL);
        await page.waitForFunction(() => document.documentElement.classList.contains('app-ready') && document.getElementById('app')?.dataset.status, null, { timeout: 8000 });
        await p.fn(page);
        assert(errors.length === 0, `page errors: ${errors.join('; ')}`);
      } finally {
        await context.close();
      }
    }
    console.log(`PASS  ${p.name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL  ${p.name}\n      ${String(e.message).split('\n')[0]}`);
  }
}
await browser.close();
console.log(`\n${selected.length - failed}/${selected.length} probes passed`);
process.exit(failed ? 1 : 0);
