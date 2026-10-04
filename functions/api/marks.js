// ============================================================
// /api/marks — общая разметка дашборда: чтение и запись.
//
// Живёт рядом со страницей (Cloudflare Pages Functions), поэтому origin
// у них один и CORS не нужен вовсе.
//
// ------------------------------------------------------------------
// Что здесь важно и почему именно так:
//
// 1. Пишем ДЕЛЬТУ, а не весь свод, и внутри объекта — только ТРОНУТЫЕ
//    ПОЛЯ. Записи по объекту целиком мало: человек ставит метку, а в
//    запрос уезжает и его копия чужой заметки — устаревшая на те
//    секунды, пока второй её дописывал. Заметка молча заменялась
//    старой версией. Поймано проверкой двумя браузерами 2026-08-20.
//
//    Правило то же, что и у файла выгрузки: ОТСУТСТВИЕ поля значит
//    «не знаю, не трогай», явный null — «стёрто». Разница только в
//    том, что здесь отсутствие выражается отсутствием ключа.
// 2. Снятая отметка — строка с пустыми полями, а НЕ удаление строки.
//    Удалённая строка не попадает в ответ «что изменилось после rev N»,
//    и снятая метка возвращалась бы обратно при следующем опросе.
// 3. Номер правки выдаёт база одним UPDATE ... RETURNING, а не
//    вычисляет MAX(rev). MAX между чтением и записью успевает устареть,
//    и два одновременных клика получают один номер — один из них
//    потом не доедет до второго браузера.
// 4. Сначала читаем meta.rev, потом строки rev <= него. В обратном
//    порядке правка, легшая между двумя запросами, получила бы номер
//    меньше возвращённого, и её никто уже не запросил бы.
// 5. Нет токена в окружении — отказ. Не «работаем без проверки»:
//    забытая переменная не должна выглядеть как исправная защита.
// 6. Вид страницы (применённые фильтры) лежит ЗДЕСЬ ЖЕ и тоже общий.
//    Разделения по пользователям в этом API нет нигде: ссылку
//    открывают двое, и оба обязаны видеть один список. Строка одна на
//    таблицу (ns), а не на человека. Отдаётся всегда целиком — это
//    несколько сотен байт, дельта тут дороже самой передачи.
// ============================================================

const MAX_CHANGES = 5000;   // импорт папиной разметки идёт пачками
const MAX_NOTE = 4000;      // заметка человека, а не вставленный роман
const MAX_ID = 400;
const MAX_VIEWS = 20;       // таблиц на странице единицы, не десятки
const MAX_VIEW = 20000;     // вид — это фильтры, а не выгрузка данных
const MAX_NS = 80;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

// Проверка общего секрета. Пока Access выключен, это не защита от того,
// кому попала ссылка (токен лежит в самой странице), а защита от того,
// кто нащупал только адрес API.
function denied(request, env) {
  if (!env.SYNC_TOKEN) {
    return json({ ошибка: 'На сервере не задан SYNC_TOKEN' }, 500);
  }
  // Обе стороны подрезаются. Секрет попадает сюда через консоль или
  // через панель, и хвостовой перевод строки к нему цепляется молча:
  // страница шлёт верный токен, сервер отвечает «неверный», и понять
  // это по ответу невозможно. Значащих пробелов у токена не бывает.
  const прислан = (request.headers.get('x-sync-token') || '').trim();
  if (прислан !== String(env.SYNC_TOKEN).trim()) {
    return json({ ошибка: 'Неверный токен синхронизации' }, 403);
  }
  return null;
}

function noDb(env) {
  return env.DB ? null : json({ ошибка: 'База D1 не привязана к проекту' }, 500);
}

// Пустая строка и пустое значение — одно и то же «отметки нет».
function clean(v, max) {
  if (v == null) return null;
  const s = String(v).slice(0, max);
  return s.length ? s : null;
}

// round — раунд просмотра, целое 1..3. НЕ через clean(): это число, а не
// строка. Клиент сравнивает его строгим равенством (выбор «—» снимает
// раунд, а select отдаёт значение текстом), и приведённый к тексту раунд
// молча перестал бы совпадать — селект показывал бы «—» при живом
// значении в базе. Предел задан здесь же, рядом с проверкой: ROUND_OPTS
// на странице и этот зажим — два разных места, и список раундов шире
// трёх потребует правки обоих.
function cleanRound(v) {
  return v == null ? null : Math.max(1, Math.min(3, Math.round(Number(v))));
}

export async function onRequestGet({ request, env }) {
  const bad = denied(request, env) || noDb(env);
  if (bad) return bad;

  const url = new URL(request.url);
  const raw = url.searchParams.get('since');
  const since = Number.isFinite(Number(raw)) ? Math.max(0, Number(raw)) : 0;

  // Порядок обязателен: сначала верхняя граница, потом строки под ней.
  const head = await env.DB.prepare('SELECT v FROM meta WHERE k = ?1').bind('rev').first();
  const rev = head ? head.v : 0;

  const { results } = await env.DB
    .prepare('SELECT id, color, note, fin, round, author FROM marks WHERE rev > ?1 AND rev <= ?2')
    .bind(since, rev)
    .all();

  // round обязан быть В ОТВЕТЕ, а не только в базе. Страница сливает
  // приехавшую запись по полям этого ответа и чего в нём нет — забывает:
  // раунд, выставленный секунду назад, стёрся бы первым же опросом, и
  // выглядело бы это как «не сохраняется само», без ошибки нигде.
  const marks = {};
  for (const r of results || []) {
    marks[r.id] = { c: r.color, note: r.note, fin: r.fin, round: r.round, by: r.author };
  }

  // Вид отдаётся ЦЕЛИКОМ, без since. Строк тут единицы, а дельта по
  // виду означала бы «страница, открытая со старым since, фильтров не
  // увидит» — ровно тот отказ, который не виден: список показан, просто
  // не тот. Таблица могла и не появиться — старая схема базы не повод
  // ронять чтение меток.
  let views = {};
  try {
    const v = await env.DB
      .prepare('SELECT ns, state, author, at, rev FROM views')
      .all();
    for (const r of v.results || []) {
      views[r.ns] = { state: r.state, by: r.author, at: r.at, rev: r.rev };
    }
  } catch (e) {
    views = {};
  }

  return json({ rev, marks, views });
}

export async function onRequestPost({ request, env }) {
  const bad = denied(request, env) || noDb(env);
  if (bad) return bad;

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ ошибка: 'Тело запроса не разобралось как JSON' }, 400);
  }

  // changes и views независимы: правка вида приходит без единой метки,
  // и наоборот. Поэтому «нет changes» — больше не ошибка сама по себе,
  // ошибка — пустой запрос целиком.
  const changes = (body && typeof body.changes === 'object' && body.changes) || {};
  const views = (body && typeof body.views === 'object' && body.views) || {};

  const ids = Object.keys(changes).filter((id) => id && id.length <= MAX_ID);
  if (ids.length > MAX_CHANGES) {
    return json({ ошибка: `Больше ${MAX_CHANGES} правок за раз — разбейте на части` }, 413);
  }

  const nss = Object.keys(views).filter((ns) => ns && ns.length <= MAX_NS);
  if (nss.length > MAX_VIEWS) {
    return json({ ошибка: `Больше ${MAX_VIEWS} видов за раз` }, 413);
  }
  for (const ns of nss) {
    if (typeof views[ns] !== 'string') {
      return json({ ошибка: `Вид «${ns}» должен быть строкой JSON` }, 400);
    }
    if (views[ns].length > MAX_VIEW) {
      return json({ ошибка: `Вид «${ns}» длиннее ${MAX_VIEW} символов` }, 413);
    }
  }

  if (!ids.length && !nss.length) return json({ ошибка: 'Пустой список правок' }, 400);

  const author = clean(body.by, 80);
  const at = new Date().toISOString();

  // Какие поля правка трогает. Ключа нет — колонку не трогаем вовсе.
  // round — не через clean() (число, а не строка) — см. cleanRound().
  const ПОЛЯ = [
    { ключ: 'c', колонка: 'color', предел: 4 },
    { ключ: 'note', колонка: 'note', предел: MAX_NOTE },
    { ключ: 'fin', колонка: 'fin', предел: 120 },
    { ключ: 'round', колонка: 'round', раунд: true },
  ];

  // Занимаем сразу столько номеров, сколько правок: одним запросом,
  // чтобы параллельная запись не влезла в середину диапазона. Вид
  // занимает номер наравне с меткой — счётчик один на всю базу, и
  // «правка вида» обязана в нём быть видна, иначе две подряд смены
  // фильтров неотличимы одна от другой.
  const head = await env.DB
    .prepare('UPDATE meta SET v = v + ?1 WHERE k = ?2 RETURNING v')
    .bind(ids.length + nss.length, 'rev')
    .first();
  if (!head) return json({ ошибка: 'Счётчик правок не найден — база не размечена схемой' }, 500);

  const top = head.v;
  const base = top - ids.length - nss.length;   // метки: base+1 … base+ids.length

  // Обновляем ровно те колонки, что пришли. Флаг «поле присутствует»
  // уходит отдельным параметром: SQLite сам отличить «null, потому что
  // стёрли» от «null, потому что не прислали» не может.
  const upsert = env.DB.prepare(
    `INSERT INTO marks (id, color, note, fin, round, author, at, rev)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
     ON CONFLICT(id) DO UPDATE SET
       color  = CASE WHEN ?9  THEN excluded.color ELSE marks.color END,
       note   = CASE WHEN ?10 THEN excluded.note  ELSE marks.note  END,
       fin    = CASE WHEN ?11 THEN excluded.fin   ELSE marks.fin   END,
       round  = CASE WHEN ?12 THEN excluded.round ELSE marks.round END,
       author = excluded.author, at = excluded.at, rev = excluded.rev`
  );
  const log = env.DB.prepare(
    'INSERT INTO marks_log (id, color, note, fin, round, author, at, fields) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)'
  );

  const batch = [];
  ids.forEach((id, i) => {
    const m = changes[id] || {};
    const знач = {};
    const тронуто = [];
    for (const п of ПОЛЯ) {
      const есть = Object.prototype.hasOwnProperty.call(m, п.ключ);
      знач[п.колонка] = есть
        ? (п.раунд ? cleanRound(m[п.ключ]) : clean(m[п.ключ], п.предел))
        : null;
      if (есть) тронуто.push(п.колонка);
    }
    batch.push(upsert.bind(
      id, знач.color, знач.note, знач.fin, знач.round, author, at, base + i + 1,
      тронуто.indexOf('color') !== -1 ? 1 : 0,
      тронуто.indexOf('note') !== -1 ? 1 : 0,
      тронуто.indexOf('fin') !== -1 ? 1 : 0,
      тронуто.indexOf('round') !== -1 ? 1 : 0
    ));
    batch.push(log.bind(id, знач.color, знач.note, знач.fin, знач.round, author, at, тронуто.join(',')));
  });

  // Метки пишутся СВОИМ батчем и первыми. Вид — вторым и отдельным,
  // хотя приехали они одним запросом. Причина: таблицы видов в базе
  // может не быть вовсе (схему накатили не везде и не одновременно), и
  // в общем батче её отсутствие уронило бы транзакцию ЦЕЛИКОМ — вместе
  // с чужой разметкой, которая к виду никакого отношения не имеет.
  // Деградировать должен вид, а не метки: фильтр человек выставит
  // заново за секунду, разметку не восстановит никак.
  if (batch.length) await env.DB.batch(batch);

  // Вид заменяется ЦЕЛИКОМ, в отличие от метки. Разница не в
  // небрежности: у метки поля правят двое независимо (один ставит цвет,
  // второй дописывает заметку), а вид — это одна связная картина. Прислать
  // «только изменившийся фильтр» значит собрать на сервере картину,
  // которой ни у кого на экране не было.
  let видов = 0;
  if (nss.length) {
    const vset = env.DB.prepare(
      `INSERT INTO views (ns, state, author, at, rev)
       VALUES (?1, ?2, ?3, ?4, ?5)
       ON CONFLICT(ns) DO UPDATE SET
         state = excluded.state, author = excluded.author,
         at = excluded.at, rev = excluded.rev`
    );
    const vlog = env.DB.prepare(
      'INSERT INTO views_log (ns, state, author, at) VALUES (?1, ?2, ?3, ?4)'
    );
    const vbatch = [];
    nss.forEach((ns, i) => {
      vbatch.push(vset.bind(ns, views[ns], author, at, base + ids.length + i + 1));
      vbatch.push(vlog.bind(ns, views[ns], author, at));
    });
    try {
      await env.DB.batch(vbatch);
      видов = nss.length;
    } catch (e) {
      // Отвечаем 200 и честным счётчиком: метки легли, вид нет.
      // Клиент сверяет «видов» с тем, что отправлял, и возвращает
      // именно вид в очередь — метки повторно не шлёт.
      видов = 0;
    }
  }

  return json({ rev: top, принято: ids.length, видов });
}
