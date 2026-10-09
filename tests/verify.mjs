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
