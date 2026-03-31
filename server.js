const express = require('express');
const path = require('path');
const fs = require('fs');
const bodyParser = require('body-parser');
const basicAuth = require('basic-auth');
const sqlite3 = require('sqlite3').verbose();

const app = express();
const PORT = process.env.PORT || 3000;

const DB_PATH = path.join(__dirname, 'database', 'db.sqlite');
const PUBLIC_DIR = path.join(__dirname, 'public');
const IMAGES_DIR = path.join(PUBLIC_DIR, 'images');
const LOGO_DIR = path.join(IMAGES_DIR, 'logo');

// Ensure database directory exists
const dbDir = path.dirname(DB_PATH);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

// Initialize SQLite connection
const db = new sqlite3.Database(DB_PATH);

// Create tables if not exist
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    sort_order INTEGER NOT NULL DEFAULT 0
  )`);

  db.run(
    `CREATE TABLE IF NOT EXISTS dishes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category TEXT NOT NULL,
      name TEXT NOT NULL,
      price REAL NOT NULL,
      image TEXT
    )`,
    (err) => {
      if (err) {
        console.error('Ошибка создания таблицы dishes:', err);
      } else {
        seedIfNeeded();
      }
    }
  );
});

/**
 * Автозаполнение из Excel отключено.
 * Данные вносятся вручную через админ-панель.
 */
function seedIfNeeded() {
  // seed отключён — меню заполняется через /admin
}

// Middleware
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Static files
// /admin и /admin/index.html защищены — отдаём через роут с auth и вставкой токена
app.use((req, res, next) => {
  if (req.path === '/admin' || req.path === '/admin/index.html') return next();
  express.static(PUBLIC_DIR)(req, res, next);
});
// Simple basic auth for admin routes
const ADMIN_LOGIN = process.env.ADMIN_LOGIN || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin';
const ADMIN_TOKEN = Buffer.from(`${process.env.ADMIN_LOGIN || 'admin'}:${process.env.ADMIN_PASSWORD || 'admin'}`).toString('base64');

function adminAuth(req, res, next) {
  const user = basicAuth(req);
  if (!user || user.name !== ADMIN_LOGIN || user.pass !== ADMIN_PASSWORD) {
    res.set('WWW-Authenticate', 'Basic realm="Molo Admin"');
    return res.status(401).send('Требуется авторизация');
  }
  return next();
}

// API: get all categories
app.get('/api/categories', (req, res) => {
  db.all('SELECT * FROM categories ORDER BY sort_order, name', (err, rows) => {
    if (err) return res.status(500).json({ error: 'Ошибка получения категорий' });
    res.json(rows);
  });
});

// API: create category (admin only)
app.post('/api/categories', adminAuth, (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Укажите название категории' });
  db.get('SELECT MAX(sort_order) as m FROM categories', (err, row) => {
    const nextOrder = (row && row.m != null ? row.m : -1) + 1;
    db.run('INSERT INTO categories (name, sort_order) VALUES (?, ?)', [name.trim(), nextOrder], function(err) {
      if (err) {
        if (err.message.includes('UNIQUE')) return res.status(409).json({ error: 'Категория уже существует' });
        return res.status(500).json({ error: 'Ошибка создания категории' });
      }
      res.status(201).json({ id: this.lastID, name: name.trim(), sort_order: nextOrder });
    });
  });
});

// API: delete category (admin only)
app.delete('/api/categories/:id', adminAuth, (req, res) => {
  const { id } = req.params;
  db.get('SELECT name FROM categories WHERE id = ?', [id], (err, row) => {
    if (!row) return res.status(404).json({ error: 'Категория не найдена' });
    db.run('DELETE FROM categories WHERE id = ?', [id], function(err) {
      if (err) return res.status(500).json({ error: 'Ошибка удаления категории' });
      res.status(204).send();
    });
  });
});

// API: get all dishes
app.get('/api/menu', (req, res) => {
  db.all('SELECT * FROM dishes ORDER BY category, name', (err, rows) => {
    if (err) {
      console.error('Ошибка получения меню:', err);
      return res.status(500).json({ error: 'Ошибка сервера при получении меню' });
    }
    res.json(rows);
  });
});

/**
 * Публичные "мета" ассеты для фронтенда:
 * - logo: автоматический выбор файла в public/images/logo/
 */
app.get('/api/site-assets', (req, res) => {
  try {
    const logo = pickLogoPath();
    res.json({
      logo,
      logoAlt: 'Molo'
    });
  } catch (e) {
    console.error('Ошибка /api/site-assets:', e);
    res.status(500).json({ error: 'Ошибка сервера при получении ассетов' });
  }
});

/**
 * Список картинок для главной (интерьер).
 * Клиент не может листать директорию static, поэтому делаем лёгкий эндпоинт.
 * type=interior — попытаемся выбрать "интерьерные" по имени файла, иначе просто первые.
 */
app.get('/api/site-images', (req, res) => {
  try {
    const type = String(req.query.type || '').toLowerCase();
    const images = listRootImages();
    if (images.length === 0) return res.json([]);

    if (type === 'interior') {
      const picks = pickInterior(images);
      return res.json(picks.map((f) => `/images/${f}`));
    }

    res.json(images.map((f) => `/images/${f}`));
  } catch (e) {
    console.error('Ошибка /api/site-images:', e);
    res.status(500).json({ error: 'Ошибка сервера при получении изображений' });
  }
});

// API: create dish (admin only)
app.post('/api/menu', adminAuth, (req, res) => {
  const { category, name, price, image } = req.body;
  if (!category || !name || typeof price === 'undefined') {
    return res.status(400).json({ error: 'Необходимо указать category, name и price' });
  }

  const stmt = db.prepare(
    'INSERT INTO dishes (category, name, price, image) VALUES (?, ?, ?, ?)'
  );
  stmt.run(category, name, price, image || null, function (err) {
    if (err) {
      console.error('Ошибка добавления блюда:', err);
      return res.status(500).json({ error: 'Ошибка сервера при добавлении блюда' });
    }
    res.status(201).json({ id: this.lastID, category, name, price, image: image || null });
  });
});

// API: update dish (admin only)
app.put('/api/menu/:id', adminAuth, (req, res) => {
  const { id } = req.params;
  const { category, name, price, image } = req.body;

  if (!category || !name || typeof price === 'undefined') {
    return res.status(400).json({ error: 'Необходимо указать category, name и price' });
  }

  const stmt = db.prepare(
    'UPDATE dishes SET category = ?, name = ?, price = ?, image = ? WHERE id = ?'
  );
  stmt.run(category, name, price, image || null, id, function (err) {
    if (err) {
      console.error('Ошибка обновления блюда:', err);
      return res.status(500).json({ error: 'Ошибка сервера при обновлении блюда' });
    }
    if (this.changes === 0) {
      return res.status(404).json({ error: 'Блюдо не найдено' });
    }
    res.json({ id: Number(id), category, name, price, image: image || null });
  });
});

// API: delete dish (admin only)
app.delete('/api/menu/:id', adminAuth, (req, res) => {
  const { id } = req.params;
  const stmt = db.prepare('DELETE FROM dishes WHERE id = ?');
  stmt.run(id, function (err) {
    if (err) {
      console.error('Ошибка удаления блюда:', err);
      return res.status(500).json({ error: 'Ошибка сервера при удалении блюда' });
    }
    if (this.changes === 0) {
      return res.status(404).json({ error: 'Блюдо не найдено' });
    }
    res.status(204).send();
  });
});

// API: проверка токена (используется страницей /login)
app.get('/api/admin/check', adminAuth, (req, res) => {
  res.json({ ok: true });
});

// Admin page (protected) — проверяем Basic Auth, встраиваем токен в страницу
app.get(['/admin', '/admin/index.html'], (req, res) => {
  const user = basicAuth(req);
  if (!user || user.name !== ADMIN_LOGIN || user.pass !== ADMIN_PASSWORD) {
    // Нет заголовка — редиректим на страницу входа
    return res.redirect('/login.html');
  }
  let html = fs.readFileSync(path.join(PUBLIC_DIR, 'admin', 'index.html'), 'utf8');
  html = html.replace(/(<\/head>)/i, `  <meta name="admin-token" content="${ADMIN_TOKEN}">\n$1`);
  res.send(html);
});

// Fallback routes for main pages (for direct navigation)
app.get('/', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

app.get('/menu', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'menu.html'));
});

app.get('/reviews', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'reviews.html'));
});

app.get('/contacts', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'contacts.html'));
});

// Global error handler (fallback)
app.use((err, req, res, next) => {
  console.error('Необработанная ошибка:', err);
  res.status(500).json({ error: 'Внутренняя ошибка сервера' });
});

app.listen(PORT, () => {
  console.log(`Сервер Molo запущен на http://localhost:${PORT}`);
});

function listRootImages() {
  if (!fs.existsSync(IMAGES_DIR)) return [];
  const entries = fs.readdirSync(IMAGES_DIR, { withFileTypes: true });
  return entries
    .filter((e) => e.isFile())
    .map((e) => e.name)
    .filter((n) => /\.(jpe?g|png|webp|gif)$/i.test(n))
    .filter((n) => n.toLowerCase() !== 'placeholder.jpg');
}

function pickInterior(files) {
  const scored = files.map((f) => {
    const base = path.parse(f).name.toLowerCase();
    const hints = [
      'interior',
      'inside',
      'зал',
      'интер',
      'hall',
      'table',
      'стол',
      'people',
      'гость',
      'общ',
      'панорам',
      'wide'
    ];
    const score = hints.reduce((acc, h) => (base.includes(h) ? acc + 1 : acc), 0);
    return { f, score };
  });
  scored.sort((a, b) => b.score - a.score);
  const best = scored.filter((x) => x.score > 0).map((x) => x.f);
  const fallback = scored.map((x) => x.f);
  const picks = (best.length > 0 ? best : fallback).slice(0, 8);
  return picks;
}

function pickLogoPath() {
  // Сначала ищем лого.jpg / logo.jpg / logo.png прямо в корне public/images/
  const rootLogoNames = ['шапка-обложка-3.png', 'шапка-обложка-3.jpg', 'лого.jpg', 'лого.png', 'лого.webp', 'logo.svg', 'logo.png', 'logo.webp', 'logo.jpg'];
  for (const name of rootLogoNames) {
    if (fs.existsSync(path.join(IMAGES_DIR, name))) {
      return `/images/${name}`;
    }
  }

  // Запасной вариант: папка logo/ (если пользователь положит туда PNG/SVG)
  if (!fs.existsSync(LOGO_DIR)) return null;
  const entries = fs.readdirSync(LOGO_DIR, { withFileTypes: true });
  const files = entries
    .filter((e) => e.isFile())
    .map((e) => e.name)
    .filter((n) => /\.(svg|png|webp|jpe?g)$/i.test(n));
  if (files.length === 0) return null;

  const prio = (name) => {
    const ext = path.extname(name).toLowerCase();
    if (ext === '.svg') return 0;
    if (ext === '.png') return 1;
    if (ext === '.webp') return 2;
    if (ext === '.jpg' || ext === '.jpeg') return 3;
    return 9;
  };

  files.sort((a, b) => prio(a) - prio(b));
  return `/images/logo/${files[0]}`;
}
