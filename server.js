const express = require('express');
const path = require('path');
const fs = require('fs');
const bodyParser = require('body-parser');
const basicAuth = require('basic-auth');
const Database = require('better-sqlite3');
const multer = require('multer');
const cloudinary = require('cloudinary').v2;

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
const db = new Database(DB_PATH);

// Create tables if not exist
db.exec(`CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  sort_order INTEGER NOT NULL DEFAULT 0
)`);

db.exec(`CREATE TABLE IF NOT EXISTS dishes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category TEXT NOT NULL,
  name TEXT NOT NULL,
  price REAL NOT NULL,
  image TEXT
)`);

/**
 * Автозаполнение из Excel отключено.
 * Данные вносятся вручную через админ-панель.
 */

// Cloudinary config
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME || 'duguck3az',
  api_key: process.env.CLOUDINARY_API_KEY || '836386742967499',
  api_secret: process.env.CLOUDINARY_API_SECRET
});

// Multer — временное хранение в памяти перед отправкой в Cloudinary
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (/image\/(jpeg|png|webp|gif)/.test(file.mimetype)) cb(null, true);
    else cb(new Error('Только изображения'));
  }
});

// Middleware
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Static files
app.use(express.static(PUBLIC_DIR));
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

// API: upload dish image (admin only) → Cloudinary
app.post('/api/upload', adminAuth, upload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Файл не загружен' });
  const stream = cloudinary.uploader.upload_stream(
    { folder: 'molo-menu', resource_type: 'image' },
    (error, result) => {
      if (error) return res.status(500).json({ error: 'Ошибка загрузки в Cloudinary' });
      res.json({ url: result.secure_url });
    }
  );
  stream.end(req.file.buffer);
});

// API: get all categories
app.get('/api/categories', (req, res) => {
  try {
    const rows = db.prepare('SELECT * FROM categories ORDER BY sort_order, name').all();
    res.json(rows);
  } catch (e) { res.status(500).json({ error: 'Ошибка получения категорий' }); }
});

// API: create category (admin only)
app.post('/api/categories', adminAuth, (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Укажите название категории' });
  try {
    const row = db.prepare('SELECT MAX(sort_order) as m FROM categories').get();
    const nextOrder = (row && row.m != null ? row.m : -1) + 1;
    const result = db.prepare('INSERT INTO categories (name, sort_order) VALUES (?, ?)').run(name.trim(), nextOrder);
    res.status(201).json({ id: result.lastInsertRowid, name: name.trim(), sort_order: nextOrder });
  } catch (e) {
    if (e.message.includes('UNIQUE')) return res.status(409).json({ error: 'Категория уже существует' });
    res.status(500).json({ error: 'Ошибка создания категории' });
  }
});

// API: delete category (admin only)
app.delete('/api/categories/:id', adminAuth, (req, res) => {
  const { id } = req.params;
  try {
    const row = db.prepare('SELECT name FROM categories WHERE id = ?').get(id);
    if (!row) return res.status(404).json({ error: 'Категория не найдена' });
    db.prepare('DELETE FROM categories WHERE id = ?').run(id);
    res.status(204).send();
  } catch (e) { res.status(500).json({ error: 'Ошибка удаления категории' }); }
});

// API: get all dishes
app.get('/api/menu', (req, res) => {
  try {
    const rows = db.prepare('SELECT * FROM dishes ORDER BY category, name').all();
    res.json(rows);
  } catch (e) { res.status(500).json({ error: 'Ошибка сервера при получении меню' }); }
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
  if (!category || !name || typeof price === 'undefined')
    return res.status(400).json({ error: 'Необходимо указать category, name и price' });
  try {
    const result = db.prepare('INSERT INTO dishes (category, name, price, image) VALUES (?, ?, ?, ?)').run(category, name, price, image || null);
    res.status(201).json({ id: result.lastInsertRowid, category, name, price, image: image || null });
  } catch (e) { res.status(500).json({ error: 'Ошибка сервера при добавлении блюда' }); }
});

// API: update dish (admin only)
app.put('/api/menu/:id', adminAuth, (req, res) => {
  const { id } = req.params;
  const { category, name, price, image } = req.body;
  if (!category || !name || typeof price === 'undefined')
    return res.status(400).json({ error: 'Необходимо указать category, name и price' });
  try {
    const result = db.prepare('UPDATE dishes SET category = ?, name = ?, price = ?, image = ? WHERE id = ?').run(category, name, price, image || null, id);
    if (result.changes === 0) return res.status(404).json({ error: 'Блюдо не найдено' });
    res.json({ id: Number(id), category, name, price, image: image || null });
  } catch (e) { res.status(500).json({ error: 'Ошибка сервера при обновлении блюда' }); }
});

// API: delete dish (admin only)
app.delete('/api/menu/:id', adminAuth, (req, res) => {
  const { id } = req.params;
  try {
    const result = db.prepare('DELETE FROM dishes WHERE id = ?').run(id);
    if (result.changes === 0) return res.status(404).json({ error: 'Блюдо не найдено' });
    res.status(204).send();
  } catch (e) { res.status(500).json({ error: 'Ошибка сервера при удалении блюда' }); }
});

// API: проверка токена (используется страницей /login)
app.get('/api/admin/check', adminAuth, (req, res) => {
  res.json({ ok: true });
});

// Admin page — отдаётся свободно, защита через sessionStorage токен в JS
app.get(['/admin', '/admin/index.html'], (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'admin', 'index.html'));
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
