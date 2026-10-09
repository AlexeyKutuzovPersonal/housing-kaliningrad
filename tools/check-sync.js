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
// Поэтому здесь два РАЗНЫХ БРАУЗЕРА — Edge и Chrome, у каждого своё
// localStorage и свой движок, как у двух людей на двух компьютерах.
// Chrome может быть не установлен: тогда второй участник — отдельный
// контекст Edge, и проверка об этом говорит, а не молчит.
//
// Проверяется не только доставка отметок: страница обязана открыться
// без ошибок JS, разметка — пережить перезагрузку у ОБОИХ, а фильтры —
// доезжать до второго и переживать перезагрузку у обоих тоже.
//
// Фильтры стали ОБЩИМИ 2026-10-04 и лежат на сервере рядом с метками:
// разделения по пользователям здесь нет нигде, ссылку открывают двое и
// обязаны видеть один список. До этого они были личными, и шесть
// недель это выглядело как пропажа чужой работы. Сортировка осталась
// личной — она ничего не прячет.
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
// Очередей две — метки и вид, — и ждать надо обеих. Вид уходит с
// задержкой полторы секунды (ползунок крутят до нужного списка), так
// что без этого проверка спрашивает со второго браузера раньше, чем
// первый вообще отправил.
async function settle(page, кто) {
  await until('очередь ' + кто + ' опустела', async () =>
    await page.evaluate(() => {
      const s = window.slSync.state();
      return s.pending === 0 && !s.viewPending;
    }), 15000, 200);
}

// Чужая правка доезжает опросом раз в 20 секунд — в стенде его зовём
// руками, иначе каждая проверка стоила бы этих двадцати секунд.
async function sync(...pages) {
  for (const p of pages) await p.evaluate(() => window.slSync.poll());
  await sleep(600);
}

function itogNote(m) {
  return !!(m && m.note && m.note.indexOf('дописываю') !== -1);
}

function killTree(pid) {
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(pid), '/T', '/F']);
  else process.kill(pid);
}

async function main() {
  const wrangler = path.join(ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js');

  // ---------- 0. миграция ADD COLUMN не роняет то, что уже размечено ----------
  // Отдельно от всего, что ниже: здесь база сперва заводится СО СТАРОЙ
  // схемой (какой она была до 2026-10-04, без round) и правдоподобной
  // строкой с цветом, заметкой и отделкой плюс строкой общего вида — так,
  // как выглядит боевая база ДО применения migrations/2026-10-04-round.sql.
  // В боевой на этот момент 295 отметок, 250 заметок и папины фильтры;
  // миграция обязана оставить их теми же, добавив только round = NULL.
  console.log('0. Миграция round.sql на базе со старой схемой (без round)…');
  const d1 = (sql) => {
    const r = spawnSync(process.execPath,
      [wrangler, 'd1', 'execute', 'dom-kgd-marks', '--local', '--yes', `--command=${sql}`],
      { cwd: ROOT, encoding: 'utf8' });
    if (r.status !== 0) {
      console.error(r.stderr || r.stdout);
      throw new Error('d1 execute упал на: ' + sql.slice(0, 80));
    }
    return r.stdout;
  };
  d1('DROP TABLE IF EXISTS marks; DROP TABLE IF EXISTS marks_log; DROP TABLE IF EXISTS meta; DROP TABLE IF EXISTS views; DROP TABLE IF EXISTS views_log;');
  // Схема ДО миграции — ровно то, что лежало в schema.sql до 2026-10-04
  // (без колонки round). Завести её здесь сразу правильной значило бы не
  // проверить вообще ничего.
  d1(`CREATE TABLE marks (id TEXT PRIMARY KEY, color TEXT, note TEXT, fin TEXT, author TEXT, at TEXT NOT NULL, rev INTEGER NOT NULL);
CREATE TABLE marks_log (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL, color TEXT, note TEXT, fin TEXT, author TEXT, at TEXT NOT NULL, fields TEXT);
CREATE TABLE views (ns TEXT PRIMARY KEY, state TEXT NOT NULL, author TEXT, at TEXT NOT NULL, rev INTEGER NOT NULL);
CREATE TABLE views_log (seq INTEGER PRIMARY KEY AUTOINCREMENT, ns TEXT NOT NULL, state TEXT NOT NULL, author TEXT, at TEXT NOT NULL);
CREATE TABLE meta (k TEXT PRIMARY KEY, v INTEGER NOT NULL);
INSERT INTO meta (k, v) VALUES ('rev', 2);
INSERT INTO marks (id, color, note, fin, author, at, rev) VALUES ('t:до-миграции', 'g', 'заметка до миграции', 'косметический', 'игорь', '2026-01-01T00:00:00Z', 1);
INSERT INTO views (ns, state, author, at, rev) VALUES ('hs', '{"filters":{"Year":2010},"keepUnknown":true,"marks":["g"],"hasNote":false,"rounds":[]}', 'игорь', '2026-01-01T00:00:00Z', 2);`);
  const schemaMig = spawnSync(process.execPath,
    [wrangler, 'd1', 'execute', 'dom-kgd-marks', '--local', '--file=migrations/2026-10-04-round.sql', '--yes'],
    { cwd: ROOT, encoding: 'utf8' });
  if (schemaMig.status !== 0) {
    console.error(schemaMig.stderr || schemaMig.stdout);
    throw new Error('миграция migrations/2026-10-04-round.sql не легла');
  }
  // Проверяем не то, как САМ wrangler d1 execute форматирует NULL в JSON
  // (у него на столбце, добавленном ALTER TABLE, есть своя причуда —
  // отдаёт строку "null" текстом, а не JSON-значение null), а РЕАЛЬНЫЙ
  // путь чтения: та же самая функция functions/api/marks.js, что стоит
  // в проде, читает базу через биндинг D1. Временный сервер — только на
  // время этой проверки, дальше поднимется постоянный для сквозных.
  console.log('  поднимаю временный сервер — читаю тем же кодом, что в проде…');
  const migSrv = spawn(process.execPath,
    [wrangler, 'pages', 'dev', '--port', String(PORT), '--ip', '127.0.0.1',
      '--binding', 'SYNC_TOKEN=' + TOKEN],
    { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  let migLog = '';
  migSrv.stdout.on('data', (d) => { migLog += d; });
  migSrv.stderr.on('data', (d) => { migLog += d; });
  try {
    await until('временный сервер отвечает', async () => {
      const r = await fetch(`${BASE}/api/marks?since=0`, { headers: { 'x-sync-token': TOKEN } });
      return r.ok;
    }, 90000).catch((e) => { console.error(migLog.slice(-1500)); throw e; });
    const body = await (await fetch(`${BASE}/api/marks?since=0`,
      { headers: { 'x-sync-token': TOKEN } })).json();
    const m = body.marks && body.marks['t:до-миграции'];
    ok(!!(m && m.c === 'g' && m.note === 'заметка до миграции' && m.fin === 'косметический'),
      'после миграции /api/marks по-прежнему отдаёт цвет/заметку/отделку существующей строки');
    ok(!!m && m.round == null,
      'round у строки, заведённой ДО миграции, — null («раунд не назначен»), а не ошибка и не 0');
    // Фильтры отца с 2026-10-04 живут ТОЛЬКО здесь, и миграция marks
    // проходит в сантиметре от них. Снимок их забирает, но проверить, что
    // забирать ещё есть что, дешевле до выкладки, чем после.
    const v = body.views && body.views.hs;
    ok(!!(v && v.state.indexOf('"Year":2010') !== -1 && v.by === 'игорь'),
      'общий вид (применённые фильтры) миграцию тоже пережил без изменений');
  } finally {
    killTree(migSrv.pid);
  }
  console.log('  готово — существующая разметка миграцию пережила без потерь\n');

  // ---------- дальше как раньше: свежая схема для сквозных проверок ----------
  // Схема в локальной базе. Прогоняется каждый раз: таблиц может не
  // быть вовсе, а «CREATE TABLE IF NOT EXISTS» ничего не ломает.
  console.log('Схема в локальной базе…');

  // База пересоздаётся ЦЕЛИКОМ, а не дочищается. Две причины.
  // Первая: остатки прошлого прогона делают стенд зелёным на сломанном
  // коде — «отметка доехала» может оказаться вчерашней.
  // Вторая: CREATE TABLE IF NOT EXISTS не меняет уже существующую
  // таблицу, и новая колонка в схеме молча не появляется. Ровно на
  // этом стенд и встал 2026-08-20: код писал в колонку, которой в
  // локальной базе не было.
  const drop = spawnSync(process.execPath,
    [wrangler, 'd1', 'execute', 'dom-kgd-marks', '--local', '--yes',
      '--command=DROP TABLE IF EXISTS marks; DROP TABLE IF EXISTS marks_log; DROP TABLE IF EXISTS meta; DROP TABLE IF EXISTS views; DROP TABLE IF EXISTS views_log;'],
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


  // Токен серверу задаётся ЯВНО, из того же .sync-token, что зашит в
  // страницу генератором. Раньше он брался из .dev.vars — отдельного
  // файла, который при ротации ключа никто не правит: стенд вставал
  // целиком с «не дождались: сервер отвечает», и это ещё повезло. Та же
  // развилка в бою выглядела иначе — страница открывалась, а разметка
  // шесть недель не доезжала. Один источник на оба конца, расходиться
  // нечему.
  console.log(`Поднимаю сервер на ${BASE} …`);
  const srv = spawn(process.execPath,
    [wrangler, 'pages', 'dev', '--port', String(PORT), '--ip', '127.0.0.1',
      '--binding', 'SYNC_TOKEN=' + TOKEN],
    { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  srv.stdout.on('data', (d) => { log += d; });
  srv.stderr.on('data', (d) => { log += d; });

  let browser = null;
  let второй = null;
  try {
    await until('сервер отвечает', async () => {
      const r = await fetch(`${BASE}/api/marks?since=0`, { headers: { 'x-sync-token': TOKEN } });
      return r.ok;
    }, 90000).catch((e) => { console.error(log.slice(-1500)); throw e; });
    console.log('Сервер поднялся.\n');

    // ДВА РАЗНЫХ БРАУЗЕРА, а не две вкладки одного. Отдельный контекст
    // уже даёт своё localStorage, но общий движок скрывает целый класс
    // расхождений; страницу открывают на разных машинах и в разном
    // софте. Edge есть всегда (им ходят сборщики), Chrome — не на всякой
    // машине, поэтому его отсутствие не проваливает проверку, а честно
    // проговаривается: тогда «второй человек» — отдельный контекст Edge.
    browser = await chromium.launch({ channel: 'msedge', headless: !HEADED });
    try {
      второй = await chromium.launch({ channel: 'chrome', headless: !HEADED });
    } catch (e) {
      console.log('Chrome не найден — второй участник будет отдельным контекстом Edge.');
    }
    console.log(`Браузеры: Алексей — Edge ${browser.version()}, `
      + `папа — ${второй ? 'Chrome ' + второй.version() : 'Edge, отдельный контекст'}\n`);

    // Два контекста — это два разных человека: у каждого своё
    // localStorage, свои отметки, своя очередь отправки.
    // Ошибки JS собираем с обеих вкладок. Сломанный компонент не мешает
    // странице отрисоваться, и «таблица есть» её исправности не значит.
    const errors = { 'Алексей': [], 'папа': [] };

    const mk = async (кто, где) => {
      const ctx = await (где || browser).newContext();
      // Подписываем заранее: иначе на первой же правке вылезет prompt
      // и заблокирует страницу.
      await ctx.addInitScript((имя) => {
        try { localStorage.setItem('house-kgd-marks:who', имя); } catch (e) {}
      }, кто);
      const p = await ctx.newPage();
      p.on('pageerror', (e) => errors[кто].push(String(e.message).slice(0, 160)));
      await p.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 120000 });
      await p.waitForSelector('#hsBody tr', { timeout: 120000 });
      return p;
    };

    // Сколько строк показано сейчас. Берём из счётчика самой страницы,
    // а не считаем <tr>: расхождение этих двух чисел — тоже поломка.
    const shown = async (p) => await p.evaluate(() => {
      const t = (document.getElementById('hsCount') || {}).textContent || '';
      const m = t.match(/показано (\d+) из (\d+)/);
      const rows = document.querySelectorAll('#hsBody tr').length;
      return m ? { показано: +m[1], всего: +m[2], строк: rows } : null;
    });

    console.log('Открываю страницу как два разных человека…');
    const A = await mk('Алексей');
    const B = await mk('папа', второй);

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

    // --- 4б. перенос метки с запасного ключа не теряет заметку и раунд ---
    // Метка живёт под старым ключом строки (так бывает после смены
    // площадки-победителя), страница показывает её как свою. Первая правка
    // переносит её на текущий ключ. До 2026-10-09 под новым ключом уезжало
    // только правленое поле, а со старого стирались цвет, заметка и
    // отделка — заметка терялась на сервере, раунд висел под старым ключом.
    console.log('\n4б. Перенос метки с запасного ключа строки');
    const пара = await A.evaluate(() => {
      const rows = JSON.parse(document.getElementById('hsData').textContent);
      const shown = new Set([...document.querySelectorAll('#hsBody .mkb')].map((b) => b.dataset.id));
      const r = rows.find((x) => shown.has(x.id) && x.altIds && x.altIds.length);
      return r ? { id: r.id, alt: r.altIds[0] } : null;
    });
    ok(!!пара, 'на странице есть строка с запасным ключом');
    if (пара) {
      const заметкаАлт = 'заметка под старым ключом';
      const посев = await fetch(`${BASE}/api/marks`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-sync-token': TOKEN },
        body: JSON.stringify({ by: 'игорь', changes: { [пара.alt]: { c: 'y', note: заметкаАлт, round: 2 } } }),
      });
      ok(посев.ok, 'метка с заметкой и раундом посеяна под запасным ключом');
      await sync(A, B);
      const усыновлена = await A.evaluate((x) => {
        const btn = document.querySelector('#hsBody .mkb[data-id="' + CSS.escape(x) + '"]');
        const tr = btn ? btn.closest('tr') : null;
        return !!(tr && tr.classList.contains('mk-y'));
      }, пара.id);
      ok(усыновлена, 'строка показывает метку старого ключа как свою');
      await A.click(`#hsBody .mkb[data-id="${пара.id}"][data-c="g"]`);
      await settle(A, 'Алексея');
      const сервер = await (await fetch(`${BASE}/api/marks?since=0`, { headers: { 'x-sync-token': TOKEN } })).json();
      const нов = сервер.marks[пара.id] || {}, стар = сервер.marks[пара.alt] || {};
      ok(нов.c === 'g' && нов.note === заметкаАлт && нов.round === 2,
        'на сервере под текущим ключом — новый цвет, прежняя заметка и прежний раунд');
      ok(!стар.c && !стар.note && !стар.round, 'под старым ключом погашено всё, включая раунд');
      await sync(B);
      const уПапы = await B.evaluate((x) => window.slStore.marks()[x], пара.id);
      ok(!!(уПапы && уПапы.note === заметкаАлт && уПапы.round === 2 && уПапы.c === 'g'),
        'второй браузер видит перенесённую заметку и раунд, а не только цвет');
      // убираем за собой: дальше проверки ждут чистую строку
      await A.click(`#hsBody .mkb[data-id="${пара.id}"][data-c="g"]`);
      await A.fill(`#hsBody .sl-note[data-id="${пара.id}"]`, '');
      await A.selectOption(`#hsBody select.sl-round[data-id="${пара.id}"]`, '');
      await settle(A, 'Алексея');
      await sync(B);
    }

    // --- 5. состояние связи проговаривается ---
    const текстПанели = await A.evaluate(() =>
      (document.getElementById('slStoreTxt') || {}).textContent || '');
    ok(текстПанели.indexOf('общая разметка') !== -1,
      'панель говорит, что разметка общая: «' + текстПанели.trim().slice(0, 60) + '»');

    // --- 6. разметка переживает перезагрузку у ОБОИХ ---
    // Метка в localStorage — это кэш, а не хранение. Проверка ровно в
    // том, что после F5 она поднимается с сервера, в том числе у того,
    // кто её не ставил: иначе «сохраняется» означало бы «сохраняется
    // до закрытия вкладки».
    console.log('\n6. Метка и заметка переживают перезагрузку у обоих');
    const заметка2 = 'звонил, договорились на субботу';
    await A.click(sel('y'));
    await A.fill(`#hsBody .sl-note[data-id="${id}"]`, заметка2);
    await settle(A, 'Алексея');
    await B.evaluate(() => window.slSync.poll());
    await sleep(800);

    for (const [p, кто] of [[A, 'у поставившего'], [B, 'у второго']]) {
      await p.reload({ waitUntil: 'domcontentloaded', timeout: 120000 });
      await p.waitForSelector('#hsBody tr', { timeout: 120000 });
      const m = await until('разметка поднялась после перезагрузки ' + кто, async () =>
        await p.evaluate((x) => {
          const v = window.slStore.marks()[x];
          return v && v.c ? v : null;
        }, id));
      ok(m.c === 'y' && m.note === заметка2, `метка и заметка на месте после перезагрузки ${кто}`);
      const виден = await p.evaluate((x) => {
        const el = document.querySelector('#hsBody .sl-note[data-id="' + CSS.escape(x) + '"]');
        const btn = document.querySelector('#hsBody .mkb[data-id="' + CSS.escape(x) + '"]');
        const tr = btn ? btn.closest('tr') : null;
        return { заметка: el ? el.value : null, цвет: tr ? tr.className : null };
      }, id);
      ok(виден.заметка === заметка2 && /mk-y/.test(виден.цвет || ''),
        `после перезагрузки это ВИДНО в таблице ${кто}, а не только лежит в памяти`);
    }

    // --- 6б. раунд просмотра доезжает и переживает перезагрузку ---
    // Независимость от цвета проверяется здесь же: у объекта уже стоят
    // жёлтая метка и заметка (секция 6), и установка раунда обязана их не
    // тронуть, как и снятие раунда ниже. Раунд — своя ось, а не оттенок
    // метки: объект бывает жёлтым без раунда и в раунде без цвета.
    console.log('\n6б. Раунд просмотра доезжает до второго и переживает перезагрузку у обоих');
    await A.selectOption(`#hsBody select.sl-round[data-id="${id}"]`, '2');
    await settle(A, 'Алексея');
    await B.evaluate(() => window.slSync.poll());
    await until('раунд приехал ко второму', async () =>
      await B.evaluate((x) => { const m = window.slStore.marks()[x]; return m && m.round === 2; }, id));
    ok(true, 'раунд 2 доехал до второго браузера');
    const выбранРаундУВторого = await B.evaluate((x) =>
      (document.querySelector('#hsBody select.sl-round[data-id="' + CSS.escape(x) + '"]') || {}).value, id);
    ok(выбранРаундУВторого === '2', 'у второго в самом select выбран «Р2», а не только в памяти');

    const доРаунда = await A.evaluate((x) => window.slStore.marks()[x], id);
    ok(!!(доРаунда && доРаунда.c === 'y' && доРаунда.note === заметка2),
      'установка раунда не тронула цвет и заметку той же строки');

    for (const [p, кто] of [[A, 'у поставившего'], [B, 'у второго']]) {
      await p.reload({ waitUntil: 'domcontentloaded', timeout: 120000 });
      await p.waitForSelector('#hsBody tr', { timeout: 120000 });
      const m = await until('раунд поднялся после перезагрузки ' + кто, async () =>
        await p.evaluate((x) => {
          const v = window.slStore.marks()[x];
          return v && v.round ? v : null;
        }, id));
      ok(m.round === 2, `раунд (2) на месте после перезагрузки ${кто}`);
      const видноРаунд = await p.evaluate((x) =>
        (document.querySelector('#hsBody select.sl-round[data-id="' + CSS.escape(x) + '"]') || {}).value, id);
      ok(видноРаунд === '2', `после перезагрузки раунд ВИДЕН в select ${кто}, а не только лежит в памяти`);
    }

    console.log('\n6в. Снятие раунда («—») доезжает и не трогает цвет/заметку');
    await A.selectOption(`#hsBody select.sl-round[data-id="${id}"]`, '');
    await settle(A, 'Алексея');
    await B.evaluate(() => window.slSync.poll());
    await until('снятие раунда доехало до второго', async () =>
      await B.evaluate((x) => { const m = window.slStore.marks()[x]; return !(m && m.round); }, id));
    ok(true, 'снятие раунда доехало до второго браузера');
    const послеСнятияРаунда = await A.evaluate((x) => window.slStore.marks()[x], id);
    ok(!!(послеСнятияРаунда && послеСнятияРаунда.c === 'y' && послеСнятияРаунда.note === заметка2),
      'снятие раунда не тронуло цвет и заметку той же строки');

    // --- 6г. у таунхаусов виджета раунда нет вовсе ---
    // Раунды заводятся таблице поимённо (markup('hs', …, { rounds })).
    // Проверка обратной стороны: включить их «всем разом» — самая
    // вероятная ошибка при переносе механики, и она выглядит как успех.
    const раундовУТаунхаусов = await A.evaluate(() =>
      document.querySelectorAll('#thBody select.sl-round').length
      + (document.getElementById('thRoundFilter') ? 1 : 0));
    ok(раундовУТаунхаусов === 0,
      'у таблицы таунхаусов ни селекта раунда, ни фильтра раунда — по решению, а не по забывчивости');

    // --- 7. фильтры общие, сортировка личная ---
    // До 2026-10-04 фильтры были личными, и это читалось как пропажа:
    // отец сужал список у себя, Алексей открывал ту же ссылку и видел
    // другой, не понимая почему. Теперь сужающее — общее и лежит на
    // сервере рядом с метками; сессий на двоих нет нигде. Сортировка
    // осталась личной: она ничего не прячет, а общая пересортировывала
    // бы чужой список после каждого клика по заголовку колонки.
    console.log('\n7. Фильтры общие, сортировка личная');
    const было = await shown(A);
    ok(было && было.показано === было.строк,
      `счётчик сходится с таблицей: показано ${было.показано} из ${было.всего}, строк ${было.строк}`);

    // Порог берём ИЗ ДАННЫХ, а не придумываем. Первая версия проверки
    // ставила «год от 2020» и падала: все 209 прошедших воронку и так
    // новее 2020, выборка не сужалась — и это говорило о тесте, а не о
    // фильтре. Порог, заведомо отсекающий часть показанного, надо
    // вычислять по тому, что на экране.
    const значения = async (p, key) => await p.evaluate((k) => {
      const ths = [...document.querySelectorAll('#hsHead th')];
      const i = ths.findIndex((t) => t.dataset.sort === k);
      if (i === -1) return [];
      return [...document.querySelectorAll('#hsBody tr')].map((tr) => {
        const td = tr.children[i];
        const v = Number(String(td ? td.textContent : '').replace(/[^\d,]/g, '').replace(',', '.'));
        return Number.isFinite(v) && v > 0 ? v : null;
      });
    }, key);

    const минуты = (await значения(A, 'mins')).filter((v) => v != null).sort((a, b) => a - b);
    const порог = минуты[Math.floor(минуты.length / 3)];
    await A.fill('#hsMins', String(порог));
    await A.dispatchEvent('#hsMins', 'change');
    await sleep(500);
    const послеФильтра = await shown(A);
    ok(послеФильтра.показано < было.показано && послеФильтра.показано > 0,
      `фильтр «минут до центра ≤ ${порог}» сузил выборку: ${было.показано} → ${послеФильтра.показано}`);
    ok(послеФильтра.показано === послеФильтра.строк, 'после фильтра счётчик по-прежнему сходится с таблицей');

    // Ради чего всё затевалось: отбор одного виден второму. Ждём, пока
    // уйдёт очередь вида, и зовём опрос у папы руками.
    await settle(A, 'Алексея');
    await sync(B);
    const уПапы = await until('фильтр доехал до папы', async () => {
      const s = await shown(B);
      return s && s.показано === послеФильтра.показано ? s : null;
    }, 15000, 400).catch(() => shown(B));
    ok(уПапы.показано === послеФильтра.показано,
      `отбор Алексея виден папе: у него теперь ${уПапы.показано}, было ${было.показано}`);
    const полеУПапы = await B.evaluate(() => (document.getElementById('hsMins') || {}).value);
    ok(Number(полеУПапы) === порог,
      `у папы в поле фильтра стоит то же значение (${полеУПапы}), а не просто совпал счётчик`);

    // Переживает перезагрузку у ОБОИХ, включая того, кто фильтр не
    // ставил: источник правды — сервер, а не localStorage поставившего.
    for (const [p, кто] of [[A, 'у поставившего'], [B, 'у второго']]) {
      await p.reload({ waitUntil: 'domcontentloaded', timeout: 120000 });
      await p.waitForSelector('#hsCount', { timeout: 120000 });
      const s = await until('общий фильтр поднялся после перезагрузки ' + кто, async () => {
        const v = await shown(p);
        return v && v.показано === послеФильтра.показано ? v : null;
      }, 20000, 400).catch(() => shown(p));
      ok(s.показано === послеФильтра.показано,
        `общий фильтр пережил перезагрузку ${кто}: ${s.показано}`);
    }

    await A.click('#hsReset');
    await settle(A, 'Алексея');
    await sleep(500);
    ok((await shown(A)).показано === было.показано, 'сброс фильтров вернул выборку к умолчанию');
    await sync(B);
    const сбросУПапы = await until('сброс доехал до папы', async () => {
      const s = await shown(B);
      return s && s.показано === было.показано ? s : null;
    }, 15000, 400).catch(() => shown(B));
    ok(сбросУПапы.показано === было.показано, 'сброс фильтров тоже общий — у папы снова полный список');

    // Снимок прежнего, личного вида. Переход на общие фильтры иначе
    // необратим: настройка, которую человек собирал неделями, исчезает.
    const снимок = await B.evaluate(() => {
      try { return localStorage.getItem('house-kgd-marks:view:hs:before-shared'); }
      catch (e) { return null; }
    });
    ok(снимок && JSON.parse(снимок) && typeof JSON.parse(снимок) === 'object',
      'у папы сохранён снимок его прежнего вида — переход на общие фильтры обратим');

    // Сортировка: щелчок по заголовку переставляет строки, повторный
    // разворачивает порядок. Проверяем не «класс появился», а реальный
    // порядок цен в отрисованных строках.
    // Цена рисуется как «6,50 млн», а у объектов с расхождением между
    // площадками рядом ещё стоит значок ⚠ — берём только число.
    // Пустые цены отбрасываем: они всегда в конце в обе стороны, и
    // монотонность по ним проверять нечего.
    //
    // Номер колонки цены берётся из #hsCfg, а не пишется числом
    // (td:nth-child(3)): «Добавлено» встало первой колонкой 2026-09-23 и
    // сдвинуло всё на одну позицию — этот тест на том и сломался один раз.
    const priceColN = await A.evaluate(() => {
      const cfg = JSON.parse(document.getElementById('hsCfg').textContent);
      return cfg.cols.findIndex((c) => c.k === 'price') + 2; // +1 за колонку «метка», +1 за 1-индексацию nth-child
    });
    const цены = async (p) => (await p.$$eval(`#hsBody tr td:nth-child(${priceColN})`,
      (tds) => tds.map((td) => Number(String(td.textContent).replace(/[^\d,]/g, '').replace(',', '.')))))
      .filter((v) => Number.isFinite(v) && v > 0);
    await A.click('#hsHead th[data-sort="price"]');
    await sleep(400);
    const вверх = await цены(A);
    ok(вверх.length > 1 && вверх.every((v, i) => i === 0 || v >= вверх[i - 1]),
      `сортировка по цене по возрастанию: ${вверх[0]} … ${вверх[вверх.length - 1]} млн`);
    await A.click('#hsHead th[data-sort="price"]');
    await sleep(400);
    const вниз = await цены(A);
    ok(вниз.length > 1 && вниз[0] >= вниз[вниз.length - 1] && вниз[0] === вверх[вверх.length - 1],
      `повторный щелчок развернул порядок: ${вниз[0]} … ${вниз[вниз.length - 1]} млн`);

    // Разметка обязана оставаться на СВОЁМ объекте при любой сортировке:
    // если бы метка привязывалась к позиции строки, а не к объявлению,
    // именно здесь она уехала бы на чужой дом.
    const наМесте = await A.evaluate((x) => {
      const btn = document.querySelector('#hsBody .mkb[data-id="' + CSS.escape(x) + '"]');
      const tr = btn ? btn.closest('tr') : null;
      if (!tr) return 'строка отфильтрована';
      const note = tr.querySelector('.sl-note');
      return { цвет: tr.className, заметка: note ? note.value : null };
    }, id);
    ok(наМесте === 'строка отфильтрована'
      || (/mk-y/.test(наМесте.цвет) && наМесте.заметка === заметка2),
    'после пересортировки метка и заметка остались на своём объекте');

    // Персистентность: «фильтр» — это ЛЮБОЙ сужающий элемент, включая
    // цветные метки и «только с заметкой», а не только FILTERS[]
    // (урок 2026-08-22: первая версия их не включила). С 2026-10-04 всё
    // это ещё и общее, то есть переживает перезагрузку через сервер, а
    // не через localStorage поставившего. Текущее живое состояние A:
    // фильтры на умолчаниях (был явный Reset выше), сортировка — по
    // цене, по убыванию, цвет не выбран.
    await A.click('#hsMarkFilter button[data-mark="g"]');
    // Ждём отправки, а не «триста миллисекунд». Вид переживает
    // перезагрузку ЧЕРЕЗ СЕРВЕР: неотправленный он не переживает её
    // намеренно (см. VQKEY в review-table.js — вчерашний вид, всплывший
    // после перезагрузки, затирает чужой новый).
    await settle(A, 'Алексея');
    const сЦветомДоF5 = await shown(A);
    await A.reload({ waitUntil: 'domcontentloaded', timeout: 120000 });
    // Не '#hsBody tr' — с применённым цветовым фильтром список может
    // оказаться пустым (0 из 209), и ждать несуществующую строку было бы
    // вечно. Счётчик отрисовывается в любом случае, пустой список или нет.
    await A.waitForSelector('#hsCount', { timeout: 120000 });
    await sleep(300);
    const послеF5 = await shown(A);
    ok(послеF5.показано === сЦветомДоF5.показано && послеF5.показано !== было.показано,
      `цветовой фильтр (не только диапазоны/сортировка) пережил перезагрузку: ${сЦветомДоF5.показано} → ${послеF5.показано} (было без фильтра ${было.показано})`);
    const кнопкаЗелёнаяПослеF5 = await A.evaluate(() =>
      (document.querySelector('#hsMarkFilter button[data-mark="g"]') || {}).classList.contains('on'));
    ok(кнопкаЗелёнаяПослеF5, 'кнопка «зелёные» после перезагрузки по-прежнему выглядит нажатой');
    // Возвращаем к умолчаниям — дальше проверки полагаются на было.показано.
    await A.click('#hsMarkFilter button[data-mark=""]');
    await settle(A, 'Алексея');
    await sleep(300);
    ok((await shown(A)).показано === было.показано, 'кнопка «все» вернула к полному списку после проверки');

    const сортПослеF5 = await A.evaluate(() => {
      const th = document.querySelector('#hsHead th[data-sort="price"]');
      return th ? th.getAttribute('data-dir') : null;
    });
    ok(сортПослеF5 === 'down',
      'сортировка по цене (по убыванию) тоже пережила перезагрузку у того же браузера');

    // Сортировка — ЛИЧНАЯ, в отличие от фильтров. Проверка ровно в том,
    // что она НЕ уехала к папе: он по колонке цены не щёлкал ни разу, и
    // его список не должен был перестроиться под чужой клик.
    await B.reload({ waitUntil: 'domcontentloaded', timeout: 120000 });
    // Не '#hsBody tr': при общем виде список после перезагрузки может
    // быть законно пустым (чужой фильтр), и ждать строку — значит ждать
    // вечно. Счётчик отрисовывается всегда.
    await B.waitForSelector('#hsCount', { timeout: 120000 });
    await sync(B);
    console.log('   (у папы после перезагрузки: ' + JSON.stringify(await shown(B))
      + ', очередь вида ' + await B.evaluate(() => window.slSync.state().viewPending) + ')');
    const сортУПапы = await B.evaluate(() => {
      const th = document.querySelector('#hsHead th[data-sort="price"]');
      return th ? th.getAttribute('data-dir') : null;
    });
    ok(сортУПапы !== 'down',
      `сортировка осталась личной: у папы по цене по-прежнему ${сортУПапы || 'без направления'}`);
    const уПапыПослеF5 = await shown(B);
    ok(уПапыПослеF5.показано === было.показано,
      `список у папы вернулся к полному вслед за сбросом цвета у Алексея: ${уПапыПослеF5.показано}`);

    // --- 7б. фильтр по цвету/меткам — multiselect ---
    // Раньше это была радио-группа (один цвет ИЛИ «без метки» ИЛИ
    // «только с заметкой» — взаимоисключающе). Теперь цвет — объединение
    // нескольких выбранных кнопок, а «есть заметка» — отдельный тумблер,
    // пересекающийся с выбором цвета.
    await A.click('#hsReset');
    await sleep(400);
    // Объект из шагов 1-6 остался жёлтым с заметкой — снимаем его, иначе
    // он попадёт в объединение цветов ниже и собьёт ожидаемый счётчик.
    await A.evaluate((x) => {
      const btn = document.querySelector('#hsBody .mkb[data-id="' + CSS.escape(x) + '"][data-c="y"]');
      if (btn) btn.click();
    }, id);
    await A.fill(`#hsBody .sl-note[data-id="${id}"]`, '').catch(() => {});
    await settle(A, 'Алексея');
    await sleep(300);
    const дваОбъекта = await A.evaluate(() =>
      [...document.querySelectorAll('#hsBody .mkb[data-c="g"]')].slice(0, 2).map((b) => b.dataset.id));
    if (дваОбъекта.length === 2) {
      const [первый, второй_id] = дваОбъекта;
      await A.click(`#hsBody .mkb[data-id="${первый}"][data-c="g"]`);
      await A.click(`#hsBody .mkb[data-id="${второй_id}"][data-c="y"]`);
      await sleep(300);
      await A.click('#hsMarkFilter button[data-mark="g"]');
      await A.click('#hsMarkFilter button[data-mark="y"]');
      await sleep(300);
      const обаЦветаВидны = await A.evaluate(() =>
        [...document.querySelectorAll('#hsBody tr')].every((tr) =>
          tr.classList.contains('mk-g') || tr.classList.contains('mk-y')));
      ok(обаЦветаВидны, 'выбор двух цветов одновременно — объединение (ИЛИ), оба на экране');

      await A.click('#hsHasNote');
      await sleep(300);
      const сЗаметкойСредиЦветных = await shown(A);
      ok(сЗаметкойСредиЦветных.показано === 0,
        '«есть заметка» пересекается (И) с выбором цвета — у тестовых меток нет заметки, список пуст');

      await A.click('#hsHasNote');
      await A.click('#hsMarkFilter button[data-mark=""]');
      await sleep(300);
      ok((await shown(A)).показано === было.показано,
        'кнопка «все» сбрасывает выбор цвета к полному списку');

      // Снимаем тестовые метки — иначе они останутся в общей разметке
      // и попадут в дальнейшие прогоны как посторонний шум.
      await A.click(`#hsBody .mkb[data-id="${первый}"][data-c="g"]`);
      await A.click(`#hsBody .mkb[data-id="${второй_id}"][data-c="y"]`);
      await settle(A, 'Алексея');
    } else {
      console.log('  (пропущено: не нашлось двух разных строк для проверки multiselect)');
    }

    // --- 7в. сохранение — делегированием, работает и для НЕИЗВЕСТНОГО панели контрола ---
    // Решающая проверка консолидации 2026-08-22: раньше сохранение
    // приклеивалось вручную к каждому обработчику, и цветные метки один
    // раз выпали именно потому, что для них забыли дописать вызов рядом.
    // Здесь — контрол, о котором review-table.js вообще ничего не знает
    // (не в FILTERS, не в коде компонента), вставленный в панель прямо
    // сейчас. Если сохранение сработало и для него — это ПО КОНСТРУКЦИИ
    // (делегирование на весь #hsControls), а не потому что кто-то не
    // забыл. Ловим вызов подменой localStorage.setItem, а не по
    // содержимому VIEW_KEY — сам контрол не часть сохраняемого среза.
    await A.evaluate(() => {
      window.__saveCalls = 0;
      var orig = localStorage.setItem.bind(localStorage);
      localStorage.setItem = function (k, v) {
        if (k.indexOf(':view:hs') !== -1) window.__saveCalls++;
        return orig(k, v);
      };
      var el = document.createElement('input');
      el.type = 'checkbox';
      el.id = 'hsRogueTestControl';
      document.getElementById('hsControls').appendChild(el);
    });
    await A.click('#hsRogueTestControl');
    await sleep(200);
    const вызовыСохранения = await A.evaluate(() => window.__saveCalls);
    ok(вызовыСохранения > 0,
      'сохранение сработало и для контрола, добавленного в панель без ведома компонента — делегирование, не поштучная проводка');
    await A.evaluate(() => { var el = document.getElementById('hsRogueTestControl'); if (el) el.remove(); });

    // --- 7ж. фильтр раунда — такой же общий, как остальные ---
    // Здесь это ОТЛИЧАЕТСЯ от задачи квартиры: там вид личный, и выбор
    // раунда живёт в localStorage своего браузера. У дома общее всё, что
    // сужает выборку, — значит и раунд. Проверяется именно доставка
    // ВЫБОРА фильтра, а не значения раунда (значение — секция 6б):
    // «раунд» лежит вне FILTERS[], своей осью, и попасть в общий срез
    // мог бы мимо — как однажды мимо сохранения попали цветные метки.
    console.log('\n7ж. Выбор фильтра раунда доезжает до второго');
    await A.click('#hsReset');
    await sleep(400);
    await A.evaluate(() => {
      const b = document.querySelector('#hsRoundFilter input[data-round="2"]');
      b.checked = true;
      b.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await settle(A, 'Алексея');
    await B.evaluate(() => window.slSync.poll());
    await until('выбор раунда приехал ко второму', async () =>
      await B.evaluate(() => {
        const b = document.querySelector('#hsRoundFilter input[data-round="2"]');
        return !!(b && b.checked);
      }));
    ok(true, 'поставленная галочка «раунд 2» доехала до второго браузера');
    ok((await B.textContent('#hsRoundSummary')).trim() === 'раунд 2',
      'у второго подпись фильтра называет выбранный раунд, а не только галочка стоит');

    for (const [p, кто] of [[A, 'у поставившего'], [B, 'у второго']]) {
      await p.reload({ waitUntil: 'domcontentloaded', timeout: 120000 });
      // Ждём САМ КОНТРОЛ, а не строку таблицы. Раунд ни одному объекту
      // сейчас не присвоен (его сняли в 6в), поэтому под фильтром «раунд
      // 2» таблица законно пуста — ожидание строки здесь не дождалось бы
      // никогда и выглядело бы поломкой страницы.
      // state: 'attached' — чекбокс лежит внутри закрытого <details> и
      // видимым не станет никогда, пока список не раскрыли.
      await p.waitForSelector('#hsRoundFilter input[data-round="2"]',
        { state: 'attached', timeout: 120000 });
      const стоит = await until('выбор раунда поднялся после перезагрузки ' + кто, async () =>
        await p.evaluate(() => {
          const b = document.querySelector('#hsRoundFilter input[data-round="2"]');
          return b && b.checked ? true : null;
        }));
      ok(стоит === true, `выбор «раунд 2» на месте после перезагрузки ${кто}`);
      // Заодно: пустой список под фильтром показывает объяснение, а не
      // просто пустоту — иначе общий фильтр читается как пропажа данных.
      ok(await p.evaluate(() => {
        const e = document.getElementById('hsEmpty');
        return !!(e && !e.hidden);
      }), `пустой под фильтром список подписан «не подошёл ни один объект» ${кто}`);
    }
    await A.click('#hsReset');
    await settle(A, 'Алексея');
    await B.evaluate(() => window.slSync.poll());
    await sleep(600);
    ok((await B.textContent('#hsRoundSummary')).trim() === 'любой',
      'сброс фильтров у одного вернул второму подпись «любой» — выбор раунда снят у обоих');

    // --- 7г. контрол под курсором чужой вид не выдёргивает ---
    // То же правило, что для заметки под курсором: пришедшая правка
    // подождёт следующего круга. Выдернутый из-под пальца ползунок
    // человек воспринимает как поломку страницы, а не как чужую правку.
    console.log('\n7г. Контрол под курсором не выдёргивается чужой правкой');
    await A.click('#hsReset');
    await settle(A, 'Алексея');
    await sync(B);
    await sleep(500);
    await B.focus('#hsMins');
    const миутДоB = await B.evaluate(() => (document.getElementById('hsMins') || {}).value);
    await A.fill('#hsMins', String(порог));
    await A.dispatchEvent('#hsMins', 'change');
    await settle(A, 'Алексея');
    await sync(B);
    const минутПослеB = await B.evaluate(() => (document.getElementById('hsMins') || {}).value);
    ok(минутПослеB === миутДоB,
      `поле под курсором у папы не перебито чужой правкой (осталось «${минутПослеB || 'пусто'}»)`);
    // Убрал курсор — догоняет сам, через повтор придержанного вида.
    await B.evaluate(() => document.activeElement && document.activeElement.blur());
    const догнал = await until('придержанный вид применился после ухода курсора', async () =>
      await B.evaluate((п) => Number((document.getElementById('hsMins') || {}).value) === п, порог),
    15000, 500).catch(() => false);
    ok(догнал, 'как только курсор ушёл, придержанный чужой фильтр применился сам');
    await A.click('#hsReset');
    await settle(A, 'Алексея');
    await sync(B);

    // --- 7д. очередь, накопленная под 403, доезжает ---
    // Ровно то, что случилось вживую: ключ страницы разошёлся с
    // серверным, сервер шесть недель отвечал 403, и разметка копилась в
    // браузере. Проверка в том, что копилась она не напрасно — после
    // починки ключа всё уезжает само, без единого действия человека.
    console.log('\n7д. Разметка, накопленная при отказе сервера, доезжает после починки');
    const id403 = await A.evaluate(() => {
      const b = [...document.querySelectorAll('#hsBody .mkb[data-c="g"]')].pop();
      return b ? b.dataset.id : null;
    });
    if (id403) {
      await A.route('**/api/marks*', (route) => route.fulfill({
        status: 403,
        contentType: 'application/json; charset=utf-8',
        body: JSON.stringify({ 'ошибка': 'Неверный токен синхронизации' }),
      }));
      await A.click(`#hsBody .mkb[data-id="${id403}"][data-c="g"]`);
      // Ждём не «очередь выросла» (это мгновенно и ничего не говорит),
      // а попытки отправки: она отложена, и до неё состояние ещё «wait».
      const состояние = await until('Алексей упёрся в отказ сервера', async () => {
        const s = await A.evaluate(() => window.slSync.state());
        return s.state === 'key' || s.state === 'offline' || s.state === 'auth' ? s.state : null;
      }, 15000, 200).catch(() => 'не дождались');
      ok(await A.evaluate(() => window.slSync.state().pending > 0),
        'правка легла в очередь браузера, а не потерялась при отказе сервера');
      ok(состояние === 'key',
        `403 опознан как «ключ не принят», а не как истёкшая сессия (состояние «${состояние}»)`);
      const панель403 = await A.evaluate(() =>
        (document.getElementById('slStoreTxt') || {}).textContent || '');
      ok(панель403.indexOf('не принимает ключ') !== -1 && панель403.indexOf('обновите страницу') === -1,
        'строка состояния не советует бесполезное обновление вкладки: «'
        + панель403.trim().slice(0, 70) + '»');
      await sync(B);
      const уПапыПока = await B.evaluate((x) => !!window.slStore.marks()[x], id403);
      ok(!уПапыПока, 'пока сервер отказывает, до второго браузера метка не доехала');

      await A.unroute('**/api/marks*');
      await A.evaluate(() => window.slSync.poll());
      await until('очередь ушла после починки', async () =>
        await A.evaluate(() => window.slSync.state().pending === 0), 20000, 300);
      await sync(B);
      const доехала = await until('метка из очереди доехала до папы', async () =>
        await B.evaluate((x) => {
          const m = window.slStore.marks()[x];
          return !!(m && m.c === 'g');
        }, id403), 20000, 500).catch(() => false);
      ok(доехала, 'накопленная под 403 метка уехала сама, без действий человека');
      // Прибираем за собой — иначе метка останется шумом в прогоне.
      await A.click(`#hsBody .mkb[data-id="${id403}"][data-c="g"]`);
      await settle(A, 'Алексея');
    } else {
      console.log('  (пропущено: не нашлось строки для проверки отказа сервера)');
    }

    // --- 7е. разовый перенос папиных фильтров в общие ---
    // В момент перехода фильтры существуют ТОЛЬКО в браузере своего
    // хозяина: ни на сервере, ни в выгрузке их нет. Правило «на
    // сервере пусто — публикует первый открывший» этого не решает — оно
    // решает лишь «хоть какой-то вид появился». Поэтому названный
    // браузер публикует свои фильтры ОДИН раз и поверх уже имеющегося,
    // в каком бы порядке страницу ни открывали. И ровно один раз:
    // иначе он возвращал бы общий вид к своему старому при каждом
    // открытии.
    console.log('\n7е. Разовый перенос фильтров названного браузера');
    const видА = await A.evaluate(() => {
      try { return localStorage.getItem('house-kgd-marks:view:hs'); } catch (e) { return null; }
    });
    const свой = JSON.parse(видА || '{}');
    свой.filters = Object.assign({}, свой.filters, { Mins: порог });
    const игорь = await (второй || browser).newContext();
    await игорь.addInitScript((o) => {
      try {
        localStorage.setItem('house-kgd-marks:who', 'игорь');
        localStorage.setItem('house-kgd-marks:view:hs', o.вид);
      } catch (e) {}
    }, { вид: JSON.stringify(свой) });
    const И = await игорь.newPage();
    И.on('pageerror', (e) => errors['папа'].push('игорь: ' + String(e.message).slice(0, 160)));
    await И.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 120000 });
    await И.waitForSelector('#hsCount', { timeout: 120000 });

    await sync(A);
    const перенесено = await until('фильтр игоря стал общим', async () =>
      await A.evaluate((п) => Number((document.getElementById('hsMins') || {}).value) === п, порог),
    20000, 600).catch(() => false);
    ok(перенесено,
      'фильтры названного браузера стали общими, хотя на сервере уже лежал чужой вид');
    const отметка = await И.evaluate(() => {
      try { return localStorage.getItem('house-kgd-marks:shared-view-seeded'); }
      catch (e) { return null; }
    });
    ok(!!отметка, 'перенос отмечен как сделанный — повториться ему нечем');

    // Второй раз переносить нельзя: иначе каждое открытие его браузера
    // возвращало бы общий вид к его старому, затирая чужую настройку.
    await A.click('#hsReset');
    await settle(A, 'Алексея');
    await И.reload({ waitUntil: 'domcontentloaded', timeout: 120000 });
    await И.waitForSelector('#hsCount', { timeout: 120000 });
    await sleep(2500);
    await sync(A);
    const неПовторился = await A.evaluate(() =>
      (document.getElementById('hsMins') || {}).value);
    ok(Number(неПовторился) !== порог,
      `при повторном открытии перенос не случился снова (у Алексея «${неПовторился || 'пусто'}», не ${порог})`);
    await И.close().catch(() => {});
    await игорь.close().catch(() => {});

    // --- 8. страница открылась без ошибок у обоих ---
    ok(errors['Алексей'].length === 0 && errors['папа'].length === 0,
      'ошибок JS ни в одной вкладке за весь прогон: '
      + ([...errors['Алексей'], ...errors['папа']].join(' | ') || 'нет'));

  } finally {
    if (browser) await browser.close().catch(() => {});
    if (второй) await второй.close().catch(() => {});
    killTree(srv.pid);
  }

  console.log(fails
    ? `\ncheck-sync: ПРОВАЛОВ ${fails} из ${checks}`
    : `\ncheck-sync: ${checks} проверок пройдено — разметка общая и доезжает в обе стороны`);
  process.exit(fails ? 1 : 0);
}

main().catch((e) => { console.error('\nОшибка: ' + e.message); process.exit(1); });
