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
// без ошибок JS, разметка — пережить перезагрузку у ОБОИХ, а фильтры и
// сортировка — работать у каждого своим порядком, не двигая чужую
// выборку.
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

    // --- 7. фильтры и сортировка ---
    // Это личный инструмент каждого: они не синхронизируются и не
    // должны. Проверяем два свойства — что они работают у каждого
    // отдельно и что чужой отбор не двигает картинку у второго.
    console.log('\n7. Фильтры и сортировка — у каждого свои');
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

    const уПапы = await shown(B);
    ok(уПапы.показано === было.показано,
      `отбор Алексея не сдвинул выборку у папы: у него по-прежнему ${уПапы.показано}`);

    await A.click('#hsReset');
    await sleep(500);
    ok((await shown(A)).показано === было.показано, 'сброс фильтров вернул выборку к умолчанию');

    // Сортировка: щелчок по заголовку переставляет строки, повторный
    // разворачивает порядок. Проверяем не «класс появился», а реальный
    // порядок цен в отрисованных строках.
    // Цена рисуется как «6,50 млн», а у объектов с расхождением между
    // площадками рядом ещё стоит значок ⚠ — берём только число.
    // Пустые цены отбрасываем: они всегда в конце в обе стороны, и
    // монотонность по ним проверять нечего.
    const цены = async (p) => (await p.$$eval('#hsBody tr td:nth-child(3)',
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

    // Честная запись поведения: фильтры и сортировка НЕ переживают
    // перезагрузку — страница всегда открывается на порогах брифа.
    // Это не забытая функция, а решение: двое обязаны видеть одинаковую
    // стартовую картину, иначе они спорят о разных списках.
    await A.reload({ waitUntil: 'domcontentloaded', timeout: 120000 });
    await A.waitForSelector('#hsBody tr', { timeout: 120000 });
    const послеF5 = await shown(A);
    ok(послеF5.показано === было.показано,
      'после перезагрузки фильтры на порогах брифа, а не там, где их оставили (так и задумано)');

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
