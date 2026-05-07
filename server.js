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
  connectionString: process.env.DATABASE_URL || 'postgresql://neondb_owner:npg_knPB7rEhGf2a@ep-solitary-meadow-ag1p6tan.c-2.eu-central-1.aws.neon.tech/neondb?sslmode=require',
  ssl: { rejectUnauthorized: false }
});

// Constants for delivery calculation
const FREE_DELIVERY_THRESHOLD = 2000;
const DELIVERY_COST = 200;

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
    description TEXT,
    price REAL NOT NULL,
    image TEXT
  )`);
  // Миграция: добавляем description если ещё нет
  await pool.query(`ALTER TABLE dishes ADD COLUMN IF NOT EXISTS description TEXT`);
  
  // Extended orders table
  await pool.query(`CREATE TABLE IF NOT EXISTS orders (
    id                   SERIAL PRIMARY KEY,
    customer_name        TEXT    NOT NULL,
    customer_phone       TEXT    NOT NULL,
    customer_email       TEXT,
    items                JSONB   NOT NULL,
    total_amount         REAL    NOT NULL,
    pickup_type          TEXT    NOT NULL DEFAULT 'self',
    status               TEXT    NOT NULL DEFAULT 'pending',
    payment_url          TEXT,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    delivery_type        TEXT    DEFAULT 'self',
    delivery_address     TEXT,
    delivery_time        TEXT,
    pickup_time          TEXT,
    delivery_comment     TEXT,
    items_count          INTEGER,
    payment_status       TEXT    DEFAULT 'pending',
    payment_operation_id TEXT,
    payment_method       TEXT,
    order_number         TEXT,
    tableware_count      INTEGER DEFAULT 1,
    session_id           TEXT,
    delivery_cost        REAL    DEFAULT 0
  )`);
  
  // Order status history table
  await pool.query(`CREATE TABLE IF NOT EXISTS order_status_history (
    id            SERIAL PRIMARY KEY,
    order_id      INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    old_status    TEXT,
    new_status    TEXT NOT NULL,
    changed_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    changed_by    TEXT
  )`);
  
  // Settings table for delivery configuration
  await pool.query(`CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT
  )`);
  
  // Insert default delivery settings if not exist
  await pool.query(`INSERT INTO settings (key, value) VALUES 
    ('free_delivery_threshold', $1),
    ('delivery_cost', $2),
    ('work_hours', $3)
  ON CONFLICT (key) DO NOTHING`, 
    [FREE_DELIVERY_THRESHOLD.toString(), DELIVERY_COST.toString(), '10:00-22:00']
  );
  
  console.log('БД инициализирована');
}

// ── PaymentService (stub for Tochka Bank integration) ─────────────────────
const PaymentService = {
  /**
   * Create payment session
   * @param {number} amount - Payment amount in rubles
   * @param {number} orderId - Order ID
   * @returns {{ paymentUrl: string, sessionId: string }}
   */
  createPayment(amount, orderId) {
    // Stub implementation - in production, this would call Tochka Bank API
    const sessionId = `session_${orderId}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const paymentUrl = `https://payment.tochka.com/pay/${sessionId}`;
    return { paymentUrl, sessionId };
  },
  
  /**
   * Check payment status
   * @param {string} sessionId - Payment session ID
   * @returns {{ status: string }} - 'pending', 'completed', 'failed'
   */
  checkPayment(sessionId) {
    // Stub implementation - in production, this would call Tochka Bank API
    return { status: 'pending' };
  }
};

// ── FiscalService (stub for receipt generation) ──────────────────────────
const FiscalService = {
  /**
   * Send receipt to fiscal system
   * @param {object} order - Order object
   * @returns {{ success: boolean, receiptUrl: string }}
   */
  sendReceipt(order) {
    // Stub implementation - in production, this would send to fiscal system
    const receiptUrl = `https://receipt.tochka.com/${order.id || 'unknown'}`;
    return { success: true, receiptUrl };
  }
};

// ── Delivery calculation helper ───────────────────────────────────────────
function calculateDeliveryCost(totalAmount, deliveryType) {
  if (deliveryType === 'self') {
    return 0;
  }
  return totalAmount >= FREE_DELIVERY_THRESHOLD ? 0 : DELIVERY_COST;
}

// ── Generate order number ─────────────────────────────────────────────────
async function generateOrderNumber(pool) {
  const year = new Date().getFullYear();
  const prefix = `MOLO-${year}-`;
  
  // Get the latest order number for this year
  const { rows } = await pool.query(
    `SELECT order_number FROM orders 
     WHERE order_number LIKE $1 
     ORDER BY id DESC LIMIT 1`,
    [`${prefix}%`]
  );
  
  let nextNumber = 1;
  if (rows.length > 0 && rows[0].order_number) {
    const lastNumber = parseInt(rows[0].order_number.replace(prefix, ''), 10);
    if (!isNaN(lastNumber)) {
      nextNumber = lastNumber + 1;
    }
  }
  
  return `${prefix}${nextNumber.toString().padStart(4, '0')}`;
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

// ── Helpers ──────────────────────────────────────────────

function getSbpPaymentUrl(orderId) {
  return `https://sbp.stub/pay/${orderId}`;
}

function formatOrderMessage(order) {
  const itemLines = (order.items || [])
    .map(i => `  • ${i.name} × ${i.quantity} — ${(i.price * i.quantity).toFixed(2)} ₽`)
    .join('\n');
  return `🛒 <b>Новый заказ #${order.id}</b>\n` +
    `👤 ${order.customer_name}\n` +
    `📞 ${order.customer_phone}\n\n` +
    `${itemLines}\n\n` +
    `💰 Итого: ${order.total_amount} ₽`;
}

async function sendTelegramNotification(order) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    console.warn('[NotificationService] TELEGRAM_BOT_TOKEN или TELEGRAM_CHAT_ID не заданы, уведомление пропущено');
    return;
  }
  const text = formatOrderMessage(order);
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' })
    });
  } catch (e) {
    console.error('[NotificationService] Ошибка отправки в Telegram:', e.message);
  }
}

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
  } catch (e) {
    console.error('Ошибка /api/menu:', e.message);
    res.status(500).json({ error: 'Ошибка получения меню' });
  }
});

app.post('/api/menu', adminAuth, async (req, res) => {
  const { category, name, description, price, image } = req.body;
  if (!category || !name || typeof price === 'undefined')
    return res.status(400).json({ error: 'Необходимо указать category, name и price' });
  try {
    const { rows } = await pool.query(
      'INSERT INTO dishes (category, name, description, price, image) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [category, name, description || null, price, image || null]
    );
    res.status(201).json(rows[0]);
  } catch (e) { res.status(500).json({ error: 'Ошибка добавления блюда' }); }
});

app.put('/api/menu/:id', adminAuth, async (req, res) => {
  const { category, name, description, price, image } = req.body;
  if (!category || !name || typeof price === 'undefined')
    return res.status(400).json({ error: 'Необходимо указать category, name и price' });
  try {
    const { rows, rowCount } = await pool.query(
      'UPDATE dishes SET category=$1, name=$2, description=$3, price=$4, image=$5 WHERE id=$6 RETURNING *',
      [category, name, description || null, price, image || null, req.params.id]
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

// Orders
app.post('/api/orders', async (req, res) => {
  const { 
    customer_name, 
    customer_phone, 
    customer_email, 
    items, 
    total_amount,
    delivery_type,
    delivery_address,
    delivery_time,
    pickup_time,
    delivery_comment,
    tableware_count,
    payment_method
  } = req.body;
  
  if (!customer_name || !customer_phone || !Array.isArray(items) || items.length === 0 || total_amount == null) {
    return res.status(400).json({ error: 'Необходимо указать customer_name, customer_phone, items и total_amount' });
  }
  
  try {
    // Calculate delivery cost
    const deliveryType = delivery_type || 'self';
    const deliveryCost = calculateDeliveryCost(total_amount, deliveryType);
    const finalTotal = total_amount + deliveryCost;
    
    // Count items
    const itemsCount = items.reduce((sum, item) => sum + (item.quantity || 1), 0);
    
    // Generate order number
    const orderNumber = await generateOrderNumber(pool);
    
    // Create payment session if needed
    let paymentUrl = null;
    let sessionId = null;
    
    if (payment_method && payment_method !== 'cash') {
      const payment = PaymentService.createPayment(finalTotal, 0);
      paymentUrl = payment.paymentUrl;
      sessionId = payment.sessionId;
    }
    
    const { rows } = await pool.query(
      `INSERT INTO orders (
        customer_name, customer_phone, customer_email, items, total_amount,
        delivery_type, delivery_address, delivery_time, pickup_time, delivery_comment,
        items_count, order_number, tableware_count, session_id, payment_method,
        delivery_cost, payment_url
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17) RETURNING *`,
      [
        customer_name, 
        customer_phone, 
        customer_email || null, 
        JSON.stringify(items), 
        finalTotal,
        deliveryType,
        delivery_address || null,
        delivery_time || null,
        pickup_time || null,
        delivery_comment || null,
        itemsCount,
        orderNumber,
        tableware_count || 1,
        sessionId,
        payment_method || null,
        deliveryCost,
        paymentUrl
      ]
    );
    
    const order = rows[0];
    
    // Update payment URL with actual order ID if needed
    if (paymentUrl && sessionId) {
      const updatedPayment = PaymentService.createPayment(finalTotal, order.id);
      paymentUrl = updatedPayment.paymentUrl;
      sessionId = updatedPayment.sessionId;
      await pool.query(
        'UPDATE orders SET payment_url = $1, session_id = $2 WHERE id = $3',
        [paymentUrl, sessionId, order.id]
      );
      order.payment_url = paymentUrl;
      order.session_id = sessionId;
    }
    
    sendTelegramNotification(order).catch(e => console.error('[NotificationService]', e.message));
    
    res.status(201).json({ 
      order_id: order.id, 
      order_number: order.order_number,
      payment_url: paymentUrl,
      session_id: sessionId,
      total_amount: finalTotal,
      delivery_cost: deliveryCost
    });
  } catch (e) {
    console.error('Ошибка создания заказа:', e);
    res.status(500).json({ error: 'Ошибка создания заказа' });
  }
});

app.get('/api/orders', adminAuth, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM orders ORDER BY created_at DESC');
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: 'Ошибка получения заказов' });
  }
});

// Delivery settings API
app.get('/api/settings/delivery', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT key, value FROM settings WHERE key IN ($1, $2, $3)', 
      ['free_delivery_threshold', 'delivery_cost', 'work_hours']
    );
    
    const settings = {};
    rows.forEach(row => {
      if (row.key === 'free_delivery_threshold' || row.key === 'delivery_cost') {
        settings[row.key] = parseFloat(row.value) || 0;
      } else {
        settings[row.key] = row.value;
      }
    });
    
    // Set defaults if not found
    settings.free_delivery_threshold = settings.free_delivery_threshold || FREE_DELIVERY_THRESHOLD;
    settings.delivery_cost = settings.delivery_cost || DELIVERY_COST;
    settings.work_hours = settings.work_hours || '10:00-22:00';
    
    res.json(settings);
  } catch (e) {
    console.error('Ошибка получения настроек доставки:', e);
    res.status(500).json({ error: 'Ошибка получения настроек доставки' });
  }
});

app.post('/api/payment/webhook', (req, res) => {
  res.json({ ok: true });
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

// Экспорт app для тестирования
module.exports = app;

// Запуск сервера только если файл запущен напрямую
if (require.main === module) {
  app.listen(PORT, () => console.log(`Сервер Molo запущен на http://localhost:${PORT}`));
}

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
