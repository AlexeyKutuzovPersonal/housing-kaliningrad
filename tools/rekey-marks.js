// ============================================================
// rekey-marks.js — свести разметку нескольких ключей в один.
//
//   node tools\rekey-marks.js --plan <отчёт merge-duplicates.json> [--url <…/api/marks>] [--apply]
//   node tools\rekey-marks.js --self-test
//
// Зачем. base-house.js --merge-duplicates сводит повторные строки одного
// дома к одной. Метка слитой строки и так видна на выжившей (её ключ —
// среди запасных), но если размечены ОБЕ строки разными заметками, видна
// только собственная метка выжившей, а вторая молча скрыта. Здесь такие
// метки склеиваются: на ключ выжившей — общий цвет и обе заметки через
// « | », с прочих ключей метка гасится явными null (как touch() страницы).
//
// По умолчанию — сухой прогон: печатает, что будет записано. --apply
// пишет, предварительно сохранив текущее состояние затронутых ключей в
// backup/rekey-<дата>.json. История правок на сервере (marks_log) хранит
// исходники и так. Адрес по умолчанию — ЛОКАЛЬНЫЙ стенд; боевой сервер
// надо назвать явно, --url.
//
// import-marks.js для этого не годится: не шлёт раунд, затирает null'ом
// поля, которых нет в файле, и не умеет гасить старый ключ.
// ============================================================

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const AUTHOR = 'слияние дублей';
const FIELDS = ['c', 'note', 'fin', 'round'];

function arg(name, def) {
  const i = process.argv.indexOf(name);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

function token() {
  if (process.env.SYNC_TOKEN) return process.env.SYNC_TOKEN;
  const f = path.join(ROOT, '.sync-token');
  if (fs.existsSync(f)) return fs.readFileSync(f, 'utf8').trim();
  throw new Error('Нет токена: положите его в Rep\\.sync-token или задайте SYNC_TOKEN');
}

const empty = (v) => v == null || v === '';

/**
 * Склейка меток группы ключей на ключ выжившей.
 * @param {string} survivor  ключ выжившей строки
 * @param {string[]} keys    все ключи группы с разметкой (включая выжившую)
 * @param {object} marks     текущие метки сервера: key → {c, note, fin, round}
 * @returns {object|null}    changes для POST /api/marks или null, если сводить нечего
 */
function mergeMarks(survivor, keys, marks) {
  const order = [survivor, ...keys.filter((k) => k !== survivor)];
  const present = order.filter((k) => marks[k] && FIELDS.some((f) => !empty(marks[k][f])));
  if (present.length < 2) return null;
  const first = (f) => { for (const k of order) if (marks[k] && !empty(marks[k][f])) return marks[k][f]; return null; };
  const notes = [...new Set(order.map((k) => marks[k] && marks[k].note).filter((n) => !empty(n)).map((n) => String(n).trim()))];
  const changes = { [survivor]: { c: first('c'), note: notes.length ? notes.join(' | ') : null, fin: first('fin'), round: first('round') } };
  order.slice(1).forEach((k) => { if (marks[k]) changes[k] = { c: null, note: null, fin: null, round: null }; });
  return changes;
}

async function main() {
  const planFile = arg('--plan', null);
  if (!planFile || !fs.existsSync(planFile)) { console.error('--plan <отчёт merge-duplicates-*.json> обязателен'); process.exit(2); }
  const url = arg('--url', 'http://127.0.0.1:8788/api/marks');
  const apply = process.argv.indexOf('--apply') !== -1;
  const plan = JSON.parse(fs.readFileSync(planFile, 'utf8'));
  const groups = plan.doubleMarked || [];

  const res = await fetch(url + '?since=0', { headers: { 'x-sync-token': token() } });
  if (!res.ok) throw new Error(`Сервер ответил ${res.status}`);
  const state = await res.json();
  const marks = state.marks || {};
  console.log(`Сервер ${url}: ревизия ${state.rev}, меток ${Object.keys(marks).length}. Групп к склейке: ${groups.length}`);

  const changes = {};
  const touched = {};
  for (const g of groups) {
    const ch = mergeMarks(g.survivor, g.keys, marks);
    if (!ch) { console.log(`  ${g.survivor}: на сервере уже одна метка — сводить нечего`); continue; }
    console.log(`\n  выжившая ${g.survivor}`);
    g.keys.forEach((k) => { const m = marks[k] || {}; touched[k] = m; console.log(`    было ${k === g.survivor ? '(своя)' : '(слитая)'} ${k}: ${JSON.stringify({ c: m.c, note: m.note, fin: m.fin, round: m.round })}`); });
    console.log(`    станет: ${JSON.stringify(ch[g.survivor])}; прочие ключи погашены`);
    Object.assign(changes, ch);
  }
  if (!Object.keys(changes).length) { console.log('\nПисать нечего.'); return; }
  if (!apply) { console.log('\nСухой прогон: ничего не записано. Записать — тот же вызов с --apply.'); return; }

  const snap = path.join(ROOT, 'backup', 'rekey-' + new Date().toISOString().slice(0, 10) + '.json');
  fs.writeFileSync(snap, JSON.stringify({ at: new Date().toISOString(), url, rev: state.rev, before: touched, changes }, null, 1), 'utf8');
  console.log(`\nСостояние до записи → ${path.relative(process.cwd(), snap)}`);
  const post = await fetch(url, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-sync-token': token() },
    body: JSON.stringify({ by: AUTHOR, changes }),
  });
  if (!post.ok) throw new Error(`Запись отклонена: ${post.status} ${(await post.text()).slice(0, 200)}`);
  const after = await (await fetch(url + '?since=0', { headers: { 'x-sync-token': token() } })).json();
  let bad = 0;
  for (const [k, want] of Object.entries(changes)) {
    const got = after.marks[k] || {};
    const okKey = FIELDS.every((f) => (empty(want[f]) ? empty(got[f]) : String(got[f]) === String(want[f])));
    if (!okKey) { bad++; console.error(`  ✗ ${k}: ждали ${JSON.stringify(want)}, на сервере ${JSON.stringify(got)}`); }
  }
  if (bad) { console.error(`\nЗаписано, но сверка не сошлась у ${bad} ключей.`); process.exit(1); }
  console.log(`✓ Записано и сверено: ${Object.keys(changes).length} ключей, ревизия ${after.rev}.`);
}

function selfTest() {
  let n = 0, bad = 0;
  const ok = (c, w) => { n++; if (!c) { bad++; console.error('✗ ' + w); } };
  const m = {
    S: { c: 'y', note: 'строители… с ремонтом', fin: null, round: null },
    L: { c: 'y', note: 'новый, застройщик', fin: 'черновая', round: 2 },
  };
  const ch = mergeMarks('S', ['S', 'L'], m);
  ok(ch.S.c === 'y' && ch.S.note === 'строители… с ремонтом | новый, застройщик', 'заметки склеены, своя первой');
  ok(ch.S.fin === 'черновая' && ch.S.round === 2, 'пустые поля выжившей взяты у слитой (отделка, раунд)');
  ok(ch.L.c === null && ch.L.note === null && ch.L.round === null && ch.L.fin === null, 'слитый ключ погашен целиком, включая раунд');
  ok(mergeMarks('S', ['S', 'L'], { S: m.S }) === null, 'одна метка — сводить нечего');
  ok(mergeMarks('S', ['S', 'L'], { S: { c: 'g', note: 'одно и то же' }, L: { c: 'g', note: 'одно и то же' } }).S.note === 'одно и то же', 'одинаковые заметки не дублируются');
  ok(mergeMarks('S', ['S', 'L'], { S: {}, L: { c: 'r', note: 'дубль' } }) === null, 'у выжившей пусто, метка одна — сводить нечего (её и так видно)');
  if (bad) { console.error(`rekey-marks.js: ПРОВАЛ ${bad} из ${n}`); process.exit(1); }
  console.log(`rekey-marks.js: ${n} проверок пройдено`);
}

if (require.main === module) {
  if (process.argv.indexOf('--self-test') !== -1) selfTest();
  else main().catch((e) => { console.error('Ошибка: ' + e.message); process.exit(1); });
}

module.exports = { mergeMarks };
