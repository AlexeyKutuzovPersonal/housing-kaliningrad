// ============================================================
// check-sync.js — проверка общей разметки ДВУМЯ браузерами.
//
//   node tools\check-sync.js [--headed] [--port 8788]
//
// Что проверяется: то единственное, ради чего всё это делалось —
// отметка, поставленная одним человеком, доезжает до второго.
//
// Почему именно так, а не проще. «Страница собралась» и «запрос
// вернул 200» не доказывают ничего: слой синхронизации может писать
// на сервер и никогда не забирать чужое, и выглядеть это будет
// исправным ровно до дня, когда двое сядут размечать одновременно.
// Поэтому здесь два ОТДЕЛЬНЫХ контекста браузера — у каждого своё
// localStorage, как у двух разных людей на двух компьютерах.
//
// Сервер поднимается локальный (wrangler pages dev) с локальной базой,
// поэтому проверка ничего не пишет в боевую разметку.
// ============================================================

'use strict';

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PW = path.join(ROOT, '..', '..', '..', 'Job Search', 'agents', 'JS_Scraper',
  'node_modules', 'playwright');
const { chromium } = require(PW);

const HEADED = process.argv.indexOf('--headed') !== -1;
const PORT = (() => {
  const i = process.argv.indexOf('--port');
  return i !== -1 && process.argv[i + 1] ? Number(process.argv[i + 1]) : 8788;
})();
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = fs.readFileSync(path.join(ROOT, '.sync-token'), 'utf8').trim();

let fails = 0;
let checks = 0;
function ok(cond, what) {
  checks++;
  if (cond) { console.log('  ок   ' + what); }
  else { fails++; console.error('  ПРОВАЛ ' + what); }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Ждём условия, а не «столько-то секунд»: фиксированная пауза либо
// растягивает проверку, либо врёт на медленной машине.
async function until(what, fn, ms = 30000, step = 500) {
  const till = Date.now() + ms;
  while (Date.now() < till) {
    let v = null;
    try { v = await fn(); } catch (e) { v = null; }
    if (v) return v;
    await sleep(step);
  }
  throw new Error('не дождались: ' + what);
}

// Правка человека уходит на сервер с задержкой (заметка иначе слала бы
// запрос на каждую букву). Прежде чем спрашивать со второго браузера,
// надо дождаться, пока очередь первого опустеет: иначе проверка ловит
// собственную гонку и выглядит как поломка синхронизации.
async function settle(page, кто) {
  await until('очередь ' + кто + ' опустела', async () =>
    await page.evaluate(() => window.slSync.state().pending === 0), 15000, 200);
}

function itogNote(m) {
  return !!(m && m.note && m.note.indexOf('дописываю') !== -1);
}

function killTree(pid) {
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(pid), '/T', '/F']);
  else process.kill(pid);
}

async function main() {
  // Схема в локальной базе. Прогоняется каждый раз: таблиц может не
  // быть вовсе, а «CREATE TABLE IF NOT EXISTS» ничего не ломает.
  console.log('Схема в локальной базе…');
  const wrangler = path.join(ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js');

  // База пересоздаётся ЦЕЛИКОМ, а не дочищается. Две причины.
  // Первая: остатки прошлого прогона делают стенд зелёным на сломанном
  // коде — «отметка доехала» может оказаться вчерашней.
  // Вторая: CREATE TABLE IF NOT EXISTS не меняет уже существующую
  // таблицу, и новая колонка в схеме молча не появляется. Ровно на
  // этом стенд и встал 2026-08-20: код писал в колонку, которой в
  // локальной базе не было.
  const drop = spawnSync(process.execPath,
    [wrangler, 'd1', 'execute', 'dom-kgd-marks', '--local', '--yes',
      '--command=DROP TABLE IF EXISTS marks; DROP TABLE IF EXISTS marks_log; DROP TABLE IF EXISTS meta;'],
    { cwd: ROOT, encoding: 'utf8' });
  if (drop.status !== 0) {
    console.error(drop.stderr || drop.stdout);
    throw new Error('не удалось пересоздать локальную базу');
  }

  const schema = spawnSync(process.execPath,
    [wrangler, 'd1', 'execute', 'dom-kgd-marks', '--local', '--file=schema.sql', '--yes'],
    { cwd: ROOT, encoding: 'utf8' });
  if (schema.status !== 0) {
    console.error(schema.stderr || schema.stdout);
    throw new Error('схема не легла');
  }


  console.log(`Поднимаю сервер на ${BASE} …`);
  const srv = spawn(process.execPath, [wrangler, 'pages', 'dev', '--port', String(PORT), '--ip', '127.0.0.1'],
    { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  srv.stdout.on('data', (d) => { log += d; });
  srv.stderr.on('data', (d) => { log += d; });

  let browser = null;
  try {
    await until('сервер отвечает', async () => {
      const r = await fetch(`${BASE}/api/marks?since=0`, { headers: { 'x-sync-token': TOKEN } });
      return r.ok;
    }, 90000).catch((e) => { console.error(log.slice(-1500)); throw e; });
    console.log('Сервер поднялся.\n');

    browser = await chromium.launch({ channel: 'msedge', headless: !HEADED });

    // Два контекста — это два разных человека: у каждого своё
    // localStorage, свои отметки, своя очередь отправки.
    const mk = async (кто) => {
      const ctx = await browser.newContext();
      // Подписываем заранее: иначе на первой же правке вылезет prompt
      // и заблокирует страницу.
      await ctx.addInitScript((имя) => {
        try { localStorage.setItem('house-kgd-marks:who', имя); } catch (e) {}
      }, кто);
      const p = await ctx.newPage();
      await p.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 120000 });
      await p.waitForSelector('#hsBody tr', { timeout: 120000 });
      return p;
    };

    console.log('Открываю две вкладки как два разных человека…');
    const A = await mk('Алексей');
    const B = await mk('папа');

    // Берём первую отрисованную строку — какая именно, неважно.
    const id = await A.evaluate(() => {
      const b = document.querySelector('#hsBody .mkb');
      return b ? b.dataset.id : null;
    });
    if (!id) throw new Error('в таблице не нашлось кнопки метки');
    console.log(`Объект для проверки: ${id}\n`);

    const sel = (cls) => `#hsBody .mkb[data-id="${id}"][data-c="${cls}"]`;

    // --- 1. метка доезжает ---
    console.log('1. Алексей ставит зелёную метку');
    await A.click(sel('g'));
    await settle(A, 'Алексея');
    await until('метка приехала к папе', async () =>
      await B.evaluate((x) => {
        const m = window.slStore.marks()[x];
        return !!(m && m.c === 'g');
      }, id));
    ok(true, 'зелёная метка доехала до второго браузера');
    const painted = await B.evaluate((x) => {
      const btn = document.querySelector('#hsBody .mkb[data-id="' + CSS.escape(x) + '"]');
      const tr = btn ? btn.closest('tr') : null;
      return !!(tr && tr.classList.contains('mk-g'));
    }, id).catch(() => false);
    ok(painted, 'строка у папы перерисовалась в зелёный, а не только обновилась в памяти');

    // --- 2. заметка доезжает ---
    console.log('\n2. Папа пишет заметку');
    const текст = 'смотрели 20 августа, крыша менялась';
    await B.fill(`#hsBody .sl-note[data-id="${id}"]`, текст);
    await settle(B, 'папы');
    await until('заметка приехала к Алексею', async () =>
      await A.evaluate((o) => {
        const m = window.slStore.marks()[o.id];
        return !!(m && m.note === o.t);
      }, { id, t: текст }));
    ok(true, 'заметка доехала в обратную сторону');

    // --- 3. одновременная правка разных полей одного объекта ---
    // Здесь ловится самая дорогая ошибка этого слоя: Алексей меняет
    // ТОЛЬКО метку, но если в запрос уедет вся запись целиком, вместе
    // с меткой уедет и его копия заметки — устаревшая ровно на те
    // секунды, пока папа её дописывал. Заметка молча заменится старой
    // версией. Так уже было 2026-08-20, поймано этим стендом.
    console.log('\n3. Папа дописывает заметку, Алексей в это же время меняет метку');
    await B.focus(`#hsBody .sl-note[data-id="${id}"]`);
    await B.type(`#hsBody .sl-note[data-id="${id}"]`, ' и ещё дописываю');
    await A.click(sel('r'));            // Алексей меняет метку в это же время
    await settle(A, 'Алексея');

    const целость = await B.evaluate((x) =>
      document.querySelector('#hsBody .sl-note[data-id="' + CSS.escape(x) + '"]').value, id);
    ok(целость.indexOf('и ещё дописываю') !== -1,
      'текст под курсором пережил приход чужой правки');

    await settle(B, 'папы');
    await A.evaluate(() => window.slSync.poll());
    await B.evaluate(() => window.slSync.poll());
    await sleep(1500);

    const итог = await A.evaluate((x) => window.slStore.marks()[x], id);
    ok(itogNote(итог), 'заметка папы НЕ затёрта чужой правкой метки');
    ok(итог && итог.c === 'r', 'метка Алексея при этом на месте');

    // --- 4. снятие доезжает ---
    // Снятая отметка обязана уехать пустой записью. Если бы клиент
    // просто молчал о снятом, у второго участника метка осталась бы
    // навсегда — и разошлись бы они необратимо.
    console.log('\n4. Алексей снимает метку и стирает заметку');

    // Папа уводит курсор из заметки. Пока курсор в поле, опрос этот
    // объект намеренно не трогает — иначе чужая правка затирала бы
    // текст на полуслове. Цена решения: правки по строке, в которой
    // человек печатает, он увидит, когда из неё уйдёт.
    await B.evaluate(() => document.activeElement && document.activeElement.blur());
    await A.click(sel('r'));                                  // повторный клик снимает
    await A.fill(`#hsBody .sl-note[data-id="${id}"]`, '');
    await settle(A, 'Алексея');
    await B.evaluate(() => window.slSync.poll());
    await until('снятие доехало до папы', async () =>
      await B.evaluate((x) => !window.slStore.marks()[x], id));
    ok(true, 'снятие метки и заметки доехало до второго браузера');

    // --- 5. состояние связи проговаривается ---
    const текстПанели = await A.evaluate(() =>
      (document.getElementById('slStoreTxt') || {}).textContent || '');
    ok(текстПанели.indexOf('общая разметка') !== -1,
      'панель говорит, что разметка общая: «' + текстПанели.trim().slice(0, 60) + '»');

  } finally {
    if (browser) await browser.close().catch(() => {});
    killTree(srv.pid);
  }

  console.log(fails
    ? `\ncheck-sync: ПРОВАЛОВ ${fails} из ${checks}`
    : `\ncheck-sync: ${checks} проверок пройдено — разметка общая и доезжает в обе стороны`);
  process.exit(fails ? 1 : 0);
}

main().catch((e) => { console.error('\nОшибка: ' + e.message); process.exit(1); });
