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

probe('matrix: three lane heads and a 5x3 grid of cells', async page => {
  const c = await page.evaluate(() => ({
    heads: document.querySelectorAll('#matrix .lane-head').length,
    rows: document.querySelectorAll('#matrix .row-head').length,
    cells: document.querySelectorAll('#matrix .cell[data-lane][data-phase]').length
  }));
  assert(c.heads === 3 && c.rows === 5 && c.cells === 15, JSON.stringify(c));
});
probe('stepper: Dalej reveals exactly one row in all three lanes', async page => {
  await page.click('#nextBtn');
  const cells = await page.evaluate(() => [...document.querySelectorAll('#matrix .cell')].map(c => `${c.dataset.phase}:${c.dataset.cell}`));
  const current = cells.filter(c => c.endsWith(':current'));
  assert(current.length === 3 && current.every(c => c.startsWith('source:')), `current: ${current}`);
  assert(!cells.some(c => c.endsWith(':shown')), 'unexpected shown cells');
  assert((await appState(page)).status === 'running', 'status not running');
});
probe('stepper: Space on a focused button advances only once', async page => {
  await page.focus('#nextBtn');
  await page.keyboard.press(' ');
  assert((await appState(page)).step === '1', 'Space double-advanced');
});
probe('stepper: step is clamped at both ends', async page => {
  await press(page, 'ArrowLeft', 3);
  assert((await appState(page)).step === '0', 'went below 0');
  await press(page, 'ArrowRight', 12);
  const s = await appState(page);
  assert(s.step === '5' && s.status === 'done', `end state ${JSON.stringify(s)}`);
  assert(await page.evaluate(() => document.getElementById('nextBtn').disabled), 'next not disabled at end');
});
probe('stepper: keyboard shortcuts R and 1-3', async page => {
  await press(page, 'ArrowRight', 2);
  await page.keyboard.press('3');
  let s = await appState(page);
  assert(s.scenario === 'task' && s.step === '0', `after 3: ${JSON.stringify(s)}`);
  await press(page, 'ArrowRight', 2);
  await page.keyboard.press('r');
  s = await appState(page);
  assert(s.step === '0', 'R did not reset');
});
probe('stepper: autoplay advances and switching scenario stops it', async page => {
  await page.keyboard.press('a');
  let s = await appState(page);
  assert(s.playing === 'true' && s.step === '1', `autoplay start ${JSON.stringify(s)}`);
  await page.keyboard.press('2');
  s = await appState(page);
  assert(s.playing === 'false' && s.scenario === 'company' && s.step === '0', `after switch ${JSON.stringify(s)}`);
  await page.waitForTimeout(3000);
  assert((await appState(page)).step === '0', 'stale timer advanced the new scenario');
});
probe('stepper: autoplay stops by itself at the end', async page => {
  await page.evaluate(() => { App.step = 4; render(); });
  await page.keyboard.press('a');
  const s = await appState(page);
  assert(s.step === '5' && s.playing === 'false', JSON.stringify(s));
});
probe('stepper: language switch keeps scenario and step', async page => {
  await page.keyboard.press('2');
  await press(page, 'ArrowRight', 3);
  await page.click('#langBtn');
  const s = await appState(page);
  assert(s.lang === 'en' && s.scenario === 'company' && s.step === '3', JSON.stringify(s));
  const cur = await page.evaluate(() => document.querySelectorAll('#matrix .cell[data-cell="current"][data-phase="action"]').length);
  assert(cur === 3, 'cell states lost after rebuild');
});
probe('a11y: live region and progress follow the step', async page => {
  await press(page, 'ArrowRight', 2);
  const info = await page.evaluate(() => ({ live: document.getElementById('live').textContent, now: document.getElementById('progress').getAttribute('aria-valuenow'), politeness: document.getElementById('live').getAttribute('aria-live') }));
  assert(info.politeness === 'polite', 'live region not polite');
  assert(info.now === '2', `aria-valuenow ${info.now}`);
  assert(info.live.includes('Krok 2 z 5') && info.live.includes('Jak pracuje?'), `live: ${info.live}`);
});
probe('flow: the current phase lights the matching node in each lane', async page => {
  await page.keyboard.press('ArrowRight');
  const active = await page.evaluate(() => [...document.querySelectorAll('.flow-node.is-active')].map(n => `${n.dataset.lane}:${n.dataset.node}`).sort().join(','));
  assert(active === 'agent:tools,chat:model,rag:docs', `active: ${active}`);
});
probe('cells: missing abilities are labelled, not left blank', async page => {
  await press(page, 'ArrowRight', 3);
  const labels = await page.evaluate(() => [...document.querySelectorAll('#matrix .cell[data-phase="action"]')].map(c => `${c.dataset.lane}:${c.dataset.use}:${c.querySelector('.use-badge')?.textContent || ''}`));
  assert(labels.includes('chat:unavailable:Tego nie potrafi') && labels.includes('rag:unavailable:Tego nie potrafi') && labels.includes('agent:unused:Potrafi, ale tu nie trzeba'), labels.join(' | '));
});

probe('verdict: winner cell is marked and graded best', async page => {
  for (const [key, winner] of [['1', 'chat'], ['2', 'rag'], ['3', 'agent']]) {
    await page.keyboard.press(key);
    await press(page, 'ArrowRight', 5);
    const w = await page.evaluate(() => [...document.querySelectorAll('#matrix .cell[data-phase="verdict"][data-winner="true"]')].map(c => ({ lane: c.dataset.lane, grade: c.querySelector('.grade')?.dataset.grade })));
    assert(w.length === 1 && w[0].lane === winner && w[0].grade === 'best', `${key}: ${JSON.stringify(w)}`);
    const live = await page.evaluate(() => document.getElementById('live').textContent);
    assert(live.includes('Wygrywa'), `live at end: ${live}`);
  }
});
probe('cost: displayed tokens match the data and bars grow chat < RAG < agent', async page => {
  await page.keyboard.press('3');
  await press(page, 'ArrowRight', 5);
  const rows = await page.evaluate(() => LANES.map(lane => {
    const cell = document.querySelector(`#matrix .cell[data-phase="verdict"][data-lane="${lane}"]`);
    const c = SCENARIO_META.task.lanes[lane].cost;
    return { lane, shown: Number(cell.querySelector('[data-tokens]')?.dataset.tokens), expected: c.in + c.out, width: cell.querySelector('.cost-bar-fill')?.getBoundingClientRect().width || 0 };
  }));
  rows.forEach(r => assert(r.shown === r.expected, `${r.lane} tokens ${r.shown} != ${r.expected}`));
  assert(rows[2].width > rows[1].width && rows[1].width > rows[0].width, `bars not ordered: ${rows.map(r => r.width)}`);
});

probe('ladder: three cards, each saying what it adds', async page => {
  const cards = await page.evaluate(() => [...document.querySelectorAll('#ladderList .ladder-step')].map(c => `${c.dataset.lane}:${c.querySelector('.ladder-adds')?.textContent || ''}`));
  assert(cards.length === 3 && cards[1].includes('+') && cards[2].includes('+'), cards.join(' | '));
});
probe('compare: table has three lane columns and full rows', async page => {
  const shape = await page.evaluate(() => ({ cols: document.querySelectorAll('#compareTable thead th').length, rows: [...document.querySelectorAll('#compareTable tbody tr')].map(r => r.children.length) }));
  assert(shape.cols === 4 && shape.rows.length === 8 && shape.rows.every(n => n === 4), JSON.stringify(shape));
});
probe('choose: each guide answer opens the scenario that approach wins', async page => {
  for (const lane of ['agent', 'rag', 'chat']) {
    await page.click(`#chooseList [data-lane="${lane}"] .choose-go`);
    const s = await appState(page);
    const winner = await page.evaluate(id => SCENARIO_META[id].winner, s.scenario);
    assert(winner === lane && s.step === '0', `${lane} -> ${s.scenario}`);
  }
});

probe('mobile: no horizontal page scroll in any scenario', async page => {
  for (const key of ['1', '2', '3']) {
    await page.keyboard.press(key);
    await press(page, 'ArrowRight', 5);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert(overflow <= 0, `scenario ${key} overflows by ${overflow}px`);
  }
}, { viewport: MOBILE });
probe('mobile: hidden rows collapse and every visible cell names its lane', async page => {
  await page.keyboard.press('ArrowRight');
  const info = await page.evaluate(() => ({
    visibleCells: [...document.querySelectorAll('#matrix .cell')].filter(c => c.offsetParent !== null).length,
    laneHeads: [...document.querySelectorAll('.lane-head')].filter(c => c.offsetParent !== null).length,
    labels: [...document.querySelectorAll('#matrix .cell[data-cell="current"]')].map(c => getComputedStyle(c, '::before').content)
  }));
  assert(info.visibleCells === 3 && info.laneHeads === 0, JSON.stringify(info));
  assert(info.labels.every(l => l && l !== 'none' && l !== 'normal'), `lane labels missing: ${info.labels}`);
}, { viewport: MOBILE });
probe('source: no Tailwind and no raw colours outside the token block', () => {
  const html = readFileSync(INDEX, 'utf8');
  assert(!html.includes('cdn.tailwindcss.com'), 'Tailwind still loaded');
  const rest = html.replace(/<style id="edu-tokens">[\s\S]*?<\/style>/, '');
  const hex = rest.match(/#[0-9a-fA-F]{3,8}\b/g) || [];
  assert(hex.length === 0, `raw hex outside tokens: ${hex.slice(0, 5)}`);
  assert(!/rgba?\(/.test(rest), 'raw rgb() outside tokens');
  assert(!rest.includes('\u2014'), 'em-dash in source');
}, { static: true });
probe('files: unused PNG diagrams removed and README written', () => {
  const left = ['agent.png', 'chat.png', 'rag.png'].filter(f => existsSync(resolve(ROOT, f)));
  assert(left.length === 0, `still present: ${left}`);
  assert(readFileSync(resolve(ROOT, 'README.md'), 'utf8').includes('node tests/verify.mjs'), 'README lacks verify instructions');
}, { static: true });

probe('flow: chip labels are readable (text colour differs from chip fill)', async page => {
  const same = await page.evaluate(() => [...document.querySelectorAll('.flow-node')].filter(n => { const s = getComputedStyle(n); return s.color === s.backgroundColor; }).map(n => `${n.dataset.lane}:${n.dataset.node}`));
  assert(same.length === 0, `invisible chip text: ${same}`);
});
probe('stepper: the revealed row is on screen below the controls', async page => {
  for (let i = 0; i < 5; i++) {
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(700);
    const r = await page.evaluate(() => {
      const cells = [...document.querySelectorAll('#matrix .cell[data-cell="current"]')];
      const controls = document.querySelector('.controls').getBoundingClientRect();
      const top = Math.min(...cells.map(c => c.getBoundingClientRect().top));
      const bottom = Math.max(...cells.map(c => c.getBoundingClientRect().bottom));
      return { top, bottom, controlsTop: controls.top, controlsBottom: controls.bottom, vh: innerHeight };
    });
    assert(r.controlsTop >= 0 && r.controlsBottom <= r.vh, `step ${i + 1}: controls off screen ${JSON.stringify(r)}`);
    assert(r.top >= r.controlsBottom - 1 && r.bottom <= r.vh, `step ${i + 1}: row not visible ${JSON.stringify(r)}`);
  }
});
probe('mobile: each step scrolls to the new row heading', async page => {
  for (let i = 0; i < 5; i++) {
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(700);
    const r = await page.evaluate(() => ({ top: document.querySelector('#matrix .row-head[data-cell="current"]').getBoundingClientRect().top, controls: document.querySelector('.controls').getBoundingClientRect().bottom }));
    assert(r.top >= r.controls && r.top <= r.controls + 40, `step ${i + 1}: row heading at ${r.top}px, controls end at ${r.controls}px`);
  }
}, { viewport: MOBILE });

probe('stepper: Dalej stays under the cursor when the new row already fits', async page => {
  await page.evaluate(() => document.getElementById('demo').scrollIntoView());
  await page.waitForTimeout(300);
  const before = await page.evaluate(() => document.getElementById('nextBtn').getBoundingClientRect().top);
  await page.click('#nextBtn');
  await page.waitForTimeout(700);
  const after = await page.evaluate(() => document.getElementById('nextBtn').getBoundingClientRect().top);
  assert(Math.abs(after - before) < 2, `Dalej moved from ${before} to ${after}`);
}, { viewport: { width: 1920, height: 1078 } });

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
