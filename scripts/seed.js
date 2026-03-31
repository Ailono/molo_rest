const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const xlsx = require('xlsx');

/**
 * Скрипт сидирования:
 * - читает Excel "Меню финал.xlsx" из корня проекта
 * - определяет категорию по названию
 * - пытается сопоставить фото из public/images (с приоритетом для "Напитки")
 * - заполняет SQLite таблицу dishes
 *
 * ВАЖНО:
 * - Скрипт не создаёт вымышленных блюд
 * - Если фото не найдено — ставит /images/placeholder.jpg
 */

const PROJECT_ROOT = path.join(__dirname, '..');
const EXCEL_NAME = 'Меню финал.xlsx';

const PUBLIC_DIR = path.join(PROJECT_ROOT, 'public');
const IMAGES_DIR = path.join(PUBLIC_DIR, 'images');

const PLACEHOLDER_REL = '/images/placeholder.jpg';
const PLACEHOLDER_ABS = path.join(IMAGES_DIR, 'placeholder.jpg');

// Очень маленький серый jpg (1x1) — чтобы был реальный placeholder.jpg без "тяжёлых" бинарников.
const PLACEHOLDER_JPG_BASE64 =
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wCEAAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQH/wAALCAABAAEBAREA/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAwT/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCkA//Z';

const CATEGORIES = [
  'Завтраки',
  'Блины',
  'Закуски',
  'На нашем хлебе',
  'Салаты',
  'Супы',
  'Паста',
  'Горячее',
  'Гарниры',
  'Детское меню',
  'Выпечка',
  'Десерты',
  'Хлеб',
  'Допы',
  'Напитки',
  'Другое'
];

const CATEGORY_NORMALIZED = new Set(CATEGORIES.map((c) => normalizeText(c)));

// Простейший словарь классификации по ключевым словам.
// Логика: чем раньше правило в массиве, тем выше приоритет.
const CATEGORY_RULES = [
  { category: 'Супы', keywords: ['суп', 'борщ', 'бульон', 'уха', 'том ям', 'том-ям', 'солянк'] },
  { category: 'Блины', keywords: ['блин', 'блины', 'налистник'] },
  { category: 'Паста', keywords: ['паста', 'пене', 'спагет', 'фетуч', 'карбона', 'болонь', 'лазан'] },
  { category: 'Салаты', keywords: ['салат', 'цезарь', 'оливье', 'винегрет'] },
  { category: 'Завтраки', keywords: ['завтрак', 'каша', 'омлет', 'яичниц', 'сырник', 'гранола', 'панкейк', 'тост'] },
  { category: 'Горячее', keywords: ['стейк', 'котлет', 'куриц', 'индейк', 'говя', 'свинин', 'рыб', 'лосос', 'дорадо', 'треск', 'кревет', 'пельмен', 'вареник', 'плов'] },
  { category: 'Гарниры', keywords: ['картоф', 'пюре', 'рис', 'греч', 'овощ', 'булгур', 'кус-кус', 'киноа'] },
  { category: 'Закуски', keywords: ['закуска', 'тартар', 'паштет', 'хумус', 'оливки', 'сырная', 'нарезк', 'брускетт'] },
  { category: 'На нашем хлебе', keywords: ['на хлебе', 'сэндвич', 'сэндвичи', 'бутерброд', 'бургер'] },
  { category: 'Выпечка', keywords: ['круассан', 'булоч', 'пирож', 'хачапури', 'фокачча'] },
  { category: 'Десерты', keywords: ['десерт', 'торт', 'чизкейк', 'мусс', 'тирамису', 'пирожное', 'морожен', 'сорбет'] },
  { category: 'Хлеб', keywords: ['хлеб', 'багет', 'чиабат', 'лепешк'] },
  { category: 'Допы', keywords: ['доп', 'соус', 'сметан', 'варенье', 'джем', 'сироп', 'масло', 'мёд', 'мед'] },
  { category: 'Напитки', keywords: ['чай', 'кофе', 'латте', 'капуч', 'эспресс', 'какао', 'морс', 'лимонад', 'вода', 'сок', 'кола', 'мохито', 'напит', 'раф'] },
  { category: 'Детское меню', keywords: ['детск', 'kids', 'kid'] }
];

const STOP_WORDS = new Set([
  'с',
  'со',
  'и',
  'на',
  'в',
  'во',
  'из',
  'к',
  'по',
  'для',
  'без',
  'под',
  'над',
  'при',
  'от',
  'или',
  'а',
  'the',
  'of',
  'with',
  'and'
]);

function normalizeText(input) {
  const s = String(input || '').toLowerCase();
  // убираем пунктуацию и лишние пробелы
  const cleaned = s
    .replace(/[\u2014\u2013—–-]/g, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned;
}

function keywordsFromDishName(name) {
  const normalized = normalizeText(name);
  const parts = normalized.split(' ').filter(Boolean);
  const filtered = parts.filter((w) => !STOP_WORDS.has(w) && w.length >= 3);
  // важные слова — в начале
  return filtered;
}

function detectCategory(dishName) {
  const text = normalizeText(dishName);
  for (const rule of CATEGORY_RULES) {
    for (const k of rule.keywords) {
      if (text.includes(k)) return rule.category;
    }
  }
  return 'Другое';
}

function listImageFiles(imagesDir) {
  if (!fs.existsSync(imagesDir)) return [];
  const entries = fs.readdirSync(imagesDir, { withFileTypes: true });
  // только файлы в корне images (logo/ исключаем)
  const files = entries
    .filter((e) => e.isFile())
    .map((e) => e.name)
    .filter((n) => /\.(jpe?g|png|webp|gif)$/i.test(n));
  return files;
}

function pickImageForDish({ dishName, category, imageFiles }) {
  if (!dishName) return null;

  const normalizedDish = normalizeText(dishName);
  const dishKeywords = keywordsFromDishName(dishName);

  const normalizedFiles = imageFiles.map((f) => ({
    file: f,
    base: normalizeText(path.parse(f).name)
  }));

  // Спец-логика для напитков: сначала пытаемся найти "стакан/cup/drink" и т.п.
  if (category === 'Напитки') {
    const drinkHints = ['стакан', 'стак', 'cup', 'drink', 'coffee', 'tea', 'latte', 'capp', 'espresso'];
    const drinkCandidates = normalizedFiles.filter((x) => drinkHints.some((h) => x.base.includes(h)));

    // 1) если нашли "стаканчиковые" файлы — пробуем матчить по ключам блюда
    if (drinkCandidates.length > 0) {
      const matched = findByKeywords(drinkCandidates, dishKeywords);
      if (matched) return `/images/${matched.file}`;
      // 2) иначе берём первый стаканчик
      return `/images/${drinkCandidates[0].file}`;
    }
  }

  // Общий матчинг: по ключевым словам блюда
  const matched = findByKeywords(normalizedFiles, dishKeywords);
  if (matched) return `/images/${matched.file}`;

  // Последняя попытка: если имя файла содержит всю строку (иногда работает)
  const fullMatch = normalizedFiles.find((x) => x.base.includes(normalizedDish));
  if (fullMatch) return `/images/${fullMatch.file}`;

  return null;
}

function findByKeywords(files, keywords) {
  for (const kw of keywords) {
    const found = files.find((x) => x.base.includes(kw));
    if (found) return found;
  }
  return null;
}

function ensurePlaceholder() {
  if (!fs.existsSync(IMAGES_DIR)) {
    fs.mkdirSync(IMAGES_DIR, { recursive: true });
  }
  if (!fs.existsSync(PLACEHOLDER_ABS)) {
    const buf = Buffer.from(PLACEHOLDER_JPG_BASE64, 'base64');
    fs.writeFileSync(PLACEHOLDER_ABS, buf);
  }
}

function openDb(dbPath) {
  return new sqlite3.Database(dbPath);
}

function run(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) return reject(err);
      resolve(this);
    });
  });
}

function all(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) return reject(err);
      resolve(rows);
    });
  });
}

function parseExcelRows(excelPath) {
  if (!fs.existsSync(excelPath)) {
    throw new Error(`Excel-файл не найден: ${excelPath}`);
  }

  const wb = xlsx.readFile(excelPath, { cellDates: false });
  const sheetName = wb.SheetNames[0];
  if (!sheetName) {
    throw new Error('В Excel нет листов');
  }

  const sheet = wb.Sheets[sheetName];
  const raw = xlsx.utils.sheet_to_json(sheet, { header: 1, raw: true, blankrows: false });
  if (!Array.isArray(raw) || raw.length === 0) return [];

  // Попытка определить заголовки
  const headerRow = (raw[0] || []).map((x) => normalizeText(x) || '');
  const nameIdx = headerRow.findIndex((h) => {
    const s = String(h || '');
    return s.includes('наимен') || s.includes('блюд') || s.includes('назван') || s === 'name';
  });
  const priceIdx = headerRow.findIndex((h) => {
    const s = String(h || '');
    return s.includes('цен') || s.includes('стоим') || s === 'price';
  });

  const startRow = nameIdx !== -1 || priceIdx !== -1 ? 1 : 0;
  const nIdx = nameIdx !== -1 ? nameIdx : 0;
  const pIdx = priceIdx !== -1 ? priceIdx : 1;

  const rows = [];
  for (let i = startRow; i < raw.length; i++) {
    const r = raw[i] || [];
    const name = String(r[nIdx] ?? '').trim();
    const priceRaw = r[pIdx];
    if (!name) continue;
    const priceStr = String(priceRaw ?? '').trim();
    if (!priceStr) continue;
    const extracted = priceStr.replace(',', '.').replace(/[^\d.]/g, '');
    if (!extracted) continue;
    const price = Number(extracted);
    if (!Number.isFinite(price)) continue;

    // Отсекаем строки, которые выглядят как заголовки категорий в Excel
    if (price === 0 && CATEGORY_NORMALIZED.has(normalizeText(name))) continue;

    rows.push({ name, price });
  }
  return rows;
}

/**
 * Основная функция сидирования.
 * @param {string} dbPath абсолютный путь к SQLite файлу
 */
async function seed(dbPath) {
  ensurePlaceholder();

  const excelPath = path.join(PROJECT_ROOT, EXCEL_NAME);
  const parsed = parseExcelRows(excelPath);
  if (parsed.length === 0) {
    throw new Error('Не удалось извлечь строки из Excel (пусто или неверный формат)');
  }

  const imageFiles = listImageFiles(IMAGES_DIR);

  const db = openDb(dbPath);
  try {
    // Если таблицы нет (например, seed запускают отдельно до server.js) — создадим.
    await run(
      db,
      `CREATE TABLE IF NOT EXISTS dishes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        category TEXT NOT NULL,
        name TEXT NOT NULL,
        price REAL NOT NULL,
        image TEXT
      )`
    );

    // По умолчанию seed НЕ трогает существующие данные.
    // Но можно вызвать "сброс" через флаг --reset (см. ниже).
    // На всякий случай — очищать не будем (чтобы не терять изменения админа),
    // но если таблица уже заполнена, этот seed вызывается сервером только при пустой таблице.
    for (const item of parsed) {
      const category = detectCategory(item.name);
      const image = pickImageForDish({ dishName: item.name, category, imageFiles }) || PLACEHOLDER_REL;
      await run(
        db,
        'INSERT INTO dishes (category, name, price, image) VALUES (?, ?, ?, ?)',
        [category, item.name, item.price, image]
      );
    }
  } finally {
    await new Promise((resolve) => db.close(resolve));
  }

  // Бонус: вернём статистику, полезно для логов
  const db2 = openDb(dbPath);
  try {
    const byCat = await all(db2, 'SELECT category, COUNT(*) as cnt FROM dishes GROUP BY category ORDER BY cnt DESC');
    return { inserted: parsed.length, categories: byCat };
  } finally {
    await new Promise((resolve) => db2.close(resolve));
  }
}

module.exports = seed;

// Запуск как standalone: node scripts/seed.js
if (require.main === module) {
  const args = process.argv.slice(2);
  const reset = args.includes('--reset');
  const dbArg = args.find((a) => a && !a.startsWith('-'));
  const dbPath = dbArg ? path.resolve(dbArg) : path.join(PROJECT_ROOT, 'database', 'db.sqlite');

  const runSeed = async () => {
    if (!reset) return seed(dbPath);
    // reset: удалить все блюда и заново залить из Excel
    const db = openDb(dbPath);
    try {
      await run(
        db,
        `CREATE TABLE IF NOT EXISTS dishes (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          category TEXT NOT NULL,
          name TEXT NOT NULL,
          price REAL NOT NULL,
          image TEXT
        )`
      );
      await run(db, 'DELETE FROM dishes');
    } finally {
      await new Promise((resolve) => db.close(resolve));
    }
    return seed(dbPath);
  };

  runSeed()
    .then((stats) => {
      console.log('Seed OK:', stats);
      process.exit(0);
    })
    .catch((e) => {
      console.error('Seed FAILED:', e);
      process.exit(1);
    });
}

