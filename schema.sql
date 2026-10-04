-- ============================================================
-- Хранилище разметки дашборда. Две таблицы, и обе нужны.
--
-- marks     — текущее состояние: что показывать при открытии страницы.
-- marks_log — все правки подряд, без удалений.
--
-- Журнал не роскошь. Пока Cloudflare Access выключен, ссылка равна
-- праву записи: любой, кому она попадёт, может стереть полгода чужой
-- работы одним кликом. Откатить можно только то, что записано.
-- ============================================================

CREATE TABLE IF NOT EXISTS marks (
  id     TEXT PRIMARY KEY,   -- «domclick:https://...» — ключ объявления
  color  TEXT,               -- 'g' | 'y' | 'r' | NULL
  note   TEXT,
  fin    TEXT,               -- отделка, переопределённая человеком
  author TEXT,
  at     TEXT NOT NULL,      -- ISO, время правки
  rev    INTEGER NOT NULL    -- номер правки, монотонный на всю базу
);

-- Опрос страницы спрашивает «что изменилось после rev N» — без индекса
-- это полный перебор таблицы на каждом опросе каждого из двоих.
CREATE INDEX IF NOT EXISTS marks_rev ON marks(rev);

CREATE TABLE IF NOT EXISTS marks_log (
  seq    INTEGER PRIMARY KEY AUTOINCREMENT,
  id     TEXT NOT NULL,
  color  TEXT,
  note   TEXT,
  fin    TEXT,
  author TEXT,
  at     TEXT NOT NULL,
  fields TEXT           -- какие поля правка реально трогала
);

CREATE INDEX IF NOT EXISTS marks_log_id ON marks_log(id);

-- ============================================================
-- Вид страницы: какие фильтры сейчас применены. ОБЩИЙ, как и метки.
--
-- Разделения по пользователям здесь нет нигде и намеренно: ссылку
-- открывают двое, и оба обязаны видеть один и тот же список. Строка
-- одна на таблицу страницы (дома, таунхаусы), а не на человека;
-- author — подпись «кто менял последним», ровно как marks.author,
-- а не признак владельца.
--
-- state — JSON вида: диапазоны, чекбоксы, цветные метки, «только с
-- заметкой», раунды. Сортировки в нём НЕТ: она ничего не прячет, а
-- общая пересортировывала бы список у второго после каждого клика по
-- заголовку колонки.
-- ============================================================
CREATE TABLE IF NOT EXISTS views (
  ns     TEXT PRIMARY KEY,   -- пространство имён таблицы на странице
  state  TEXT NOT NULL,      -- JSON применённых фильтров
  author TEXT,
  at     TEXT NOT NULL,
  rev    INTEGER NOT NULL
);

-- Журнал по той же причине, что и marks_log: откатить можно только
-- то, что записано, а фильтры здесь теперь общие и затираются чужой
-- правкой так же легко, как метка.
CREATE TABLE IF NOT EXISTS views_log (
  seq    INTEGER PRIMARY KEY AUTOINCREMENT,
  ns     TEXT NOT NULL,
  state  TEXT NOT NULL,
  author TEXT,
  at     TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS views_log_ns ON views_log(ns);

-- Счётчик правок. Отдельной строкой, а не MAX(rev) по таблице: MAX
-- пришлось бы считать при каждой записи, и два одновременных клика
-- получили бы один и тот же номер.
CREATE TABLE IF NOT EXISTS meta (
  k TEXT PRIMARY KEY,
  v INTEGER NOT NULL
);

INSERT OR IGNORE INTO meta (k, v) VALUES ('rev', 0);
