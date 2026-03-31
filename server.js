const express = require('express');
const path = require('path');
const fs = require('fs');
const bodyParser = require('body-parser');
const basicAuth = require('basic-auth');
const { Pool } = require('pg');
const multer = require('multer');
const cloudinary = require('cloudinary').v2;

const app = express();
const PORT = process.env.PORT || 3000;

const PUBLIC_DIR = path.join(__dirname, 'public');
const IMAGES_DIR = path.join(PUBLIC_DIR, 'images');

// PostgreSQL
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

// Create tables if not exist
async function initDB() {
  await pool.query(`CREATE TABLE IF NOT EXISTS categories (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    sort_order INTEGER NOT NULL DEFAULT 0
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS dishes (
    id SERIAL PRIMARY KEY,
    category TEXT NOT NULL,
    name TEXT NOT NULL,
    price REAL NOT NULL,
    image TEXT
  )`);
  console.log('БД инициализирована');
}
initDB().catch(e => console.error('Ошибка инициализации БД:', e));

// Cloudinary
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME || 'duguck3az',
  api_key: process.env.CLOUDINARY_API_KEY || '836386742967499',
  api_secret: process.env.CLOUDINARY_API_SECRET
});

// Multer — память, потом Cloudinary
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (/image\/(jpeg|png|webp|gif)/.test(file.mimetype)) cb(null, true);
    else cb(new Error('Только изображения'));
  }
});

// Auth
const ADMIN_LOGIN = process.env.ADMIN_LOGIN || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin';

function adminAuth(req, res, next) {
  const user = basicAuth(req);
  if (!user || user.name !== ADMIN_LOGIN || user.pass !== ADMIN_PASSWORD) {
    res.set('WWW-Authenticate', 'Basic realm="Molo Admin"');
    return res.status(401).send('Требуется авторизация');
  }
  return next();
}

// Middleware
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static(PUBLIC_DIR));

// ── API ───────────────────────────────────────────────────

app.get('/api/admin/check', adminAuth, (req, res) => res.json({ ok: true }));

// Categories
app.get('/api/categories', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM categories ORDER BY sort_order, name');
    res.json(rows);
  } catch (e) { res.status(500).json({ error: 'Ошибка получения категорий' }); }
});

app.post('/api/categories', adminAuth, async (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Укажите название категории' });
  try {
    const { rows } = await pool.query('SELECT MAX(sort_order) as m FROM categories');
    const nextOrder = (rows[0].m != null ? rows[0].m : -1) + 1;
    const result = await pool.query(
      'INSERT INTO categories (name, sort_order) VALUES ($1, $2) RETURNING *',
      [name.trim(), nextOrder]
    );
    res.status(201).json(result.rows[0]);
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'Категория уже существует' });
    res.status(500).json({ error: 'Ошибка создания категории' });
  }
});

app.delete('/api/categories/:id', adminAuth, async (req, res) => {
  try {
    const { rowCount } = await pool.query('DELETE FROM categories WHERE id = $1', [req.params.id]);
    if (rowCount === 0) return res.status(404).json({ error: 'Категория не найдена' });
    res.status(204).send();
  } catch (e) { res.status(500).json({ error: 'Ошибка удаления категории' }); }
});

// Dishes
app.get('/api/menu', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM dishes ORDER BY category, name');
    res.json(rows);
  } catch (e) { res.status(500).json({ error: 'Ошибка получения меню' }); }
});

app.post('/api/menu', adminAuth, async (req, res) => {
  const { category, name, price, image } = req.body;
  if (!category || !name || typeof price === 'undefined')
    return res.status(400).json({ error: 'Необходимо указать category, name и price' });
  try {
    const { rows } = await pool.query(
      'INSERT INTO dishes (category, name, price, image) VALUES ($1, $2, $3, $4) RETURNING *',
      [category, name, price, image || null]
    );
    res.status(201).json(rows[0]);
  } catch (e) { res.status(500).json({ error: 'Ошибка добавления блюда' }); }
});

app.put('/api/menu/:id', adminAuth, async (req, res) => {
  const { category, name, price, image } = req.body;
  if (!category || !name || typeof price === 'undefined')
    return res.status(400).json({ error: 'Необходимо указать category, name и price' });
  try {
    const { rows, rowCount } = await pool.query(
      'UPDATE dishes SET category=$1, name=$2, price=$3, image=$4 WHERE id=$5 RETURNING *',
      [category, name, price, image || null, req.params.id]
    );
    if (rowCount === 0) return res.status(404).json({ error: 'Блюдо не найдено' });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: 'Ошибка обновления блюда' }); }
});

app.delete('/api/menu/:id', adminAuth, async (req, res) => {
  try {
    const { rowCount } = await pool.query('DELETE FROM dishes WHERE id = $1', [req.params.id]);
    if (rowCount === 0) return res.status(404).json({ error: 'Блюдо не найдено' });
    res.status(204).send();
  } catch (e) { res.status(500).json({ error: 'Ошибка удаления блюда' }); }
});

// Image upload → Cloudinary
app.post('/api/upload', adminAuth, (req, res) => {
  upload.single('image')(req, res, (err) => {
    if (err) {
      const msg = err.code === 'LIMIT_FILE_SIZE'
        ? 'Файл слишком большой (максимум 20MB)'
        : err.message || 'Ошибка загрузки';
      return res.status(400).json({ error: msg });
    }
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
});

// Admin page
app.get(['/admin', '/admin/index.html'], (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'admin', 'index.html'));
});

app.get('/', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));
app.get('/menu', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'menu.html')));
app.get('/contacts', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'contacts.html')));
app.get('/reviews', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'reviews.html')));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Внутренняя ошибка сервера' });
});

app.listen(PORT, () => console.log(`Сервер Molo запущен на http://localhost:${PORT}`));

function listRootImages() {
  if (!fs.existsSync(IMAGES_DIR)) return [];
  return fs.readdirSync(IMAGES_DIR, { withFileTypes: true })
    .filter(e => e.isFile())
    .map(e => e.name)
    .filter(n => /\.(jpe?g|png|webp|gif)$/i.test(n));
}

function pickLogoPath() {
  const names = ['шапка-обложка-3.png', 'лого.jpg', 'logo.png', 'logo.jpg'];
  for (const name of names) {
    if (fs.existsSync(path.join(IMAGES_DIR, name))) return `/images/${name}`;
  }
  return null;
}
