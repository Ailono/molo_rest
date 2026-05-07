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
    delivery_cost        REAL    DEFAULT 0,
    receipt_id           TEXT,
    receipt_url          TEXT,
    fiscal_status        TEXT    DEFAULT 'pending',
    fiscal_error         TEXT
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

// ── Fiscal configuration ─────────────────────────────────────────────────
const FISCAL_CONFIG = {
  inn: process.env.FISCAL_INN || '',
  name: process.env.FISCAL_NAME || 'ООО "Ресторан"',
  address: process.env.FISCAL_ADDRESS || '',
  apiUrl: process.env.FISCAL_API_URL || '',
  apiKey: process.env.FISCAL_API_KEY || '',
  callbackUrl: process.env.FISCAL_CALLBACK_URL || ''
};

// ── FiscalService (cloud online cash register integration) ───────────────
const FiscalService = {
  /**
   * Send receipt for payment (54-ФЗ)
   * @param {object} order - Order object
   * @returns {{ success: boolean, receiptId?: string, receiptUrl?: string, error?: string }}
   */
  async sendReceipt(order) {
    try {
      const receiptData = this._buildReceiptData(order, 'sale');
      
      // Log the receipt data
      console.log('[FiscalService] Sending sale receipt for order:', order.id);
      console.log('[FiscalService] Receipt data:', JSON.stringify(receiptData, null, 2));
      
      // In production, make actual API call to cloud cash register
      if (FISCAL_CONFIG.apiUrl && FISCAL_CONFIG.apiKey) {
        const response = await this._sendToApi(receiptData);
        return {
          success: true,
          receiptId: response.id,
          receiptUrl: response.url
        };
      }
      
      // Stub implementation for development
      const receiptId = `receipt_${order.id}_${Date.now()}`;
      const receiptUrl = `https://receipt.cloudkassir.ru/${receiptId}`;
      
      return { success: true, receiptId, receiptUrl };
    } catch (error) {
      console.error('[FiscalService] Error sending receipt:', error.message);
      return { success: false, error: error.message };
    }
  },
  
  /**
   * Send receipt for refund (54-ФЗ)
   * @param {object} order - Order object
   * @param {number} refundAmount - Refund amount
   * @returns {{ success: boolean, receiptId?: string, receiptUrl?: string, error?: string }}
   */
  async sendRefundReceipt(order, refundAmount) {
    try {
      const receiptData = this._buildReceiptData(order, 'refund', refundAmount);
      
      console.log('[FiscalService] Sending refund receipt for order:', order.id);
      console.log('[FiscalService] Refund amount:', refundAmount);
      
      // In production, make actual API call
      if (FISCAL_CONFIG.apiUrl && FISCAL_CONFIG.apiKey) {
        const response = await this._sendToApi(receiptData);
        return {
          success: true,
          receiptId: response.id,
          receiptUrl: response.url
        };
      }
      
      // Stub implementation
      const receiptId = `refund_${order.id}_${Date.now()}`;
      const receiptUrl = `https://receipt.cloudkassir.ru/${receiptId}`;
      
      return { success: true, receiptId, receiptUrl };
    } catch (error) {
      console.error('[FiscalService] Error sending refund receipt:', error.message);
      return { success: false, error: error.message };
    }
  },
  
  /**
   * Check receipt status
   * @param {string} receiptId - Receipt ID
   * @returns {{ status: string, error?: string }}
   */
  async getReceiptStatus(receiptId) {
    try {
      console.log('[FiscalService] Checking receipt status:', receiptId);
      
      // In production, make actual API call
      if (FISCAL_CONFIG.apiUrl && FISCAL_CONFIG.apiKey) {
        const response = await this._checkStatus(receiptId);
        return { status: response.status };
      }
      
      // Stub implementation - always returns completed
      return { status: 'completed' };
    } catch (error) {
      console.error('[FiscalService] Error checking receipt status:', error.message);
      return { status: 'error', error: error.message };
    }
  },
  
  /**
   * Build receipt data according to 54-ФЗ
   * @param {object} order - Order object
   * @param {string} type - 'sale' or 'refund'
   * @param {number} [refundAmount] - Optional refund amount
   * @returns {object} Receipt data
   */
  _buildReceiptData(order, type = 'sale', refundAmount) {
    const items = (order.items || []).map(item => {
      const quantity = item.quantity || 1;
      const price = parseFloat(item.price || 0);
      const total = price * quantity;
      
      return {
        name: item.name || 'Товар',
        quantity: quantity,
        price: price,
        total: Math.round(total * 100) / 100,
        vat: item.vat || 'vat20',
        paymentMethod: 'full_prepayment',
        paymentObject: 'commodity'
      };
    });
    
    // Calculate totals
    const total = items.reduce((sum, item) => sum + item.total, 0);
    const finalTotal = refundAmount !== undefined 
      ? Math.round(refundAmount * 100) / 100 
      : total;
    
    // Build receipt object according to 54-ФЗ format
    return {
      seller: {
        inn: FISCAL_CONFIG.inn,
        name: FISCAL_CONFIG.name,
        address: FISCAL_CONFIG.address
      },
      receipt: {
        type: type,
        items: items,
        total: Math.round(finalTotal * 100) / 100,
        payments: {
          cash: 0,
          electronic: Math.round(finalTotal * 100) / 100
        },
        client: order.customer_email ? {
          email: order.customer_email
        } : order.customer_phone ? {
          phone: order.customer_phone
        } : undefined,
        company: {
          inn: FISCAL_CONFIG.inn,
          email: process.env.FISCAL_COMPANY_EMAIL || 'company@example.com'
        }
      },
      timestamp: new Date().toISOString(),
      external_id: `order_${order.id}`,
      service: {
        callback_url: FISCAL_CONFIG.callbackUrl || `https://${process.env.HOST || 'localhost'}/api/fiscal/callback`
      }
    };
  },
  
  /**
   * Send data to cloud cash register API
   * @param {object} data - Receipt data
   * @returns {Promise<object>} API response
   * @private
   */
  async _sendToApi(data) {
    const maxRetries = 3;
    let lastError;
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const response = await fetch(`${FISCAL_CONFIG.apiUrl}/v1/receipts`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${FISCAL_CONFIG.apiKey}`
          },
          body: JSON.stringify(data)
        });
        
        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`API error: ${response.status} - ${errorText}`);
        }
        
        return await response.json();
      } catch (error) {
        lastError = error;
        console.error(`[FiscalService] Attempt ${attempt} failed:`, error.message);
        
        // Wait before retry (exponential backoff)
        if (attempt < maxRetries) {
          await new Promise(resolve => setTimeout(resolve, 1000 * Math.pow(2, attempt - 1)));
        }
      }
    }
    
    throw lastError || new Error('Max retries exceeded');
  },
  
  /**
   * Check receipt status via API
   * @param {string} receiptId - Receipt ID
   * @returns {Promise<object>} Status response
   * @private
   */
  async _checkStatus(receiptId) {
    const response = await fetch(`${FISCAL_CONFIG.apiUrl}/v1/receipts/${receiptId}/status`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${FISCAL_CONFIG.apiKey}`
      }
    });
    
    if (!response.ok) {
      throw new Error(`Status check error: ${response.status}`);
    }
    
    return await response.json();
  }
};

// ── Notification configuration ─────────────────────────────────────────────
const NOTIFICATION_CONFIG = {
  telegram: {
    enabled: process.env.TELEGRAM_ENABLED === 'true',
    botToken: process.env.TELEGRAM_BOT_TOKEN,
    chatId: process.env.TELEGRAM_CHAT_ID
  },
  vk: {
    enabled: process.env.VK_ENABLED === 'true',
    token: process.env.VK_TOKEN,
    peerId: process.env.VK_PEER_ID
  },
  email: {
    enabled: process.env.EMAIL_ENABLED === 'true',
    smtpHost: process.env.SMTP_HOST,
    smtpPort: process.env.SMTP_PORT,
    smtpUser: process.env.SMTP_USER,
    smtpPass: process.env.SMTP_PASS,
    from: process.env.EMAIL_FROM,
    to: process.env.EMAIL_TO
  }
};

// ── NotificationService (multichannel notifications) ──────────────────────
const NotificationService = {
  /**
   * Send notification about new order to all enabled admin channels
   * @param {object} order - Order object
   */
  async notifyNewOrder(order) {
    const message = this._formatAdminMessage(order);
    const results = await Promise.allSettled([
      this._sendTelegram(order, message),
      this._sendVK(order, message),
      this._sendEmailAdmin(order, message)
    ]);
    
    // Log results
    results.forEach((result, index) => {
      const channel = ['Telegram', 'VK', 'Email'][index];
      if (result.status === 'fulfilled') {
        console.log(`[NotificationService] ${channel} notification sent successfully`);
      } else {
        console.error(`[NotificationService] ${channel} notification failed:`, result.reason?.message || result.reason);
      }
    });
    
    // Send confirmation to customer if email provided
    if (order.customer_email) {
      await this._sendCustomerConfirmation(order);
    }
  },
  
  /**
   * Send notification about status change
   * @param {object} order - Order object
   * @param {string} oldStatus - Previous status
   * @param {string} newStatus - New status
   */
  async notifyStatusChange(order, oldStatus, newStatus) {
    const message = this._formatStatusChangeMessage(order, oldStatus, newStatus);
    const results = await Promise.allSettled([
      this._sendTelegram(order, message),
      this._sendVK(order, message)
    ]);
    
    results.forEach((result, index) => {
      const channel = ['Telegram', 'VK'][index];
      if (result.status === 'fulfilled') {
        console.log(`[NotificationService] Status change ${channel} notification sent`);
      } else {
        console.error(`[NotificationService] Status change ${channel} failed:`, result.reason?.message || result.reason);
      }
    });
  },
  
  /**
   * Format admin notification message for new order
   * @private
   */
  _formatAdminMessage(order) {
    const items = Array.isArray(order.items) ? order.items : JSON.parse(order.items || '[]');
    const itemLines = items
      .map(i => `  • ${i.name} × ${i.quantity} — ${(i.price * i.quantity).toFixed(2)} ₽`)
      .join('\n');
    
    const deliveryType = order.delivery_type === 'self' ? 'Самовывоз' : 'Доставка';
    const time = order.pickup_time || order.delivery_time || 'Как можно скорее';
    
    return `🛒 <b>Новый заказ #${order.order_number}</b>

👤 <b>${order.customer_name}</b>
📞 ${order.customer_phone}

📦 <b>${deliveryType}</b>
🕐 Время: ${time}

<b>Заказ:</b>
${itemLines}

<b>Итого: ${order.total_amount} ₽</b>`;
  },
  
  /**
   * Format status change message
   * @private
   */
  _formatStatusChangeMessage(order, oldStatus, newStatus) {
    const statusEmoji = {
      pending: '⏳',
      paid: '💳',
      ready: '✅',
      completed: '🏁',
      cancelled: '❌',
      failed: '⚠️'
    };
    
    const statusText = {
      pending: 'Ожидает оплаты',
      paid: 'Оплачен',
      ready: 'Готов',
      completed: 'Завершён',
      cancelled: 'Отменён',
      failed: 'Ошибка оплаты'
    };
    
    return `📋 <b>Статус заказа #${order.order_number} изменён</b>

${statusEmoji[oldStatus] || '❓'} ${statusText[oldStatus] || oldStatus} → ${statusEmoji[newStatus] || '❓'} ${statusText[newStatus] || newStatus}

👤 ${order.customer_name}
📞 ${order.customer_phone}
💰 Сумма: ${order.total_amount} ₽`;
  },
  
  /**
   * Send notification via Telegram
   * @private
   */
  async _sendTelegram(order, message) {
    const { telegram } = NOTIFICATION_CONFIG;
    
    if (!telegram.enabled || !telegram.botToken || !telegram.chatId) {
      console.log('[NotificationService] Telegram disabled or not configured, skipping');
      return;
    }
    
    try {
      const response = await fetch(`https://api.telegram.org/bot${telegram.botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: telegram.chatId,
          text: message,
          parse_mode: 'HTML'
        })
      });
      
      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Telegram API error: ${response.status} - ${errorText}`);
      }
      
      console.log('[NotificationService] Telegram notification sent for order:', order.order_number);
    } catch (error) {
      console.error('[NotificationService] Telegram error:', error.message);
      throw error;
    }
  },
  
  /**
   * Send notification via VK
   * @private
   */
  async _sendVK(order, message) {
    const { vk } = NOTIFICATION_CONFIG;
    
    if (!vk.enabled || !vk.token || !vk.peerId) {
      console.log('[NotificationService] VK disabled or not configured, skipping');
      return;
    }
    
    try {
      const response = await fetch('https://api.vk.com/method/messages.send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          access_token: vk.token,
          peer_id: vk.peerId,
          message: message.replace(/<[^>]*>/g, ''), // Strip HTML for VK
          random_id: Date.now()
        })
      });
      
      const data = await response.json();
      
      if (data.error) {
        throw new Error(`VK API error: ${data.error.error_msg}`);
      }
      
      console.log('[NotificationService] VK notification sent for order:', order.order_number);
    } catch (error) {
      console.error('[NotificationService] VK error:', error.message);
      throw error;
    }
  },
  
  /**
   * Send admin notification via email
   * @private
   */
  async _sendEmailAdmin(order, message) {
    const { email } = NOTIFICATION_CONFIG;
    
    if (!email.enabled || !email.smtpHost || !email.to) {
      console.log('[NotificationService] Email disabled or not configured for admin, skipping');
      return;
    }
    
    try {
      // Use nodemailer if available, otherwise use simple mailto
      const nodemailer = require('nodemailer');
      
      const transporter = nodemailer.createTransport({
        host: email.smtpHost,
        port: parseInt(email.smtpPort) || 587,
        secure: email.smtpPort === '465',
        auth: {
          user: email.smtpUser,
          pass: email.smtpPass
        }
      });
      
      await transporter.sendMail({
        from: email.from || email.smtpUser,
        to: email.to,
        subject: `Новый заказ #${order.order_number}`,
        html: message.replace(/\n/g, '<br>')
      });
      
      console.log('[NotificationService] Admin email sent for order:', order.order_number);
    } catch (error) {
      console.error('[NotificationService] Email error:', error.message);
      throw error;
    }
  },
  
  /**
   * Send confirmation email to customer
   * @private
   */
  async _sendCustomerConfirmation(order) {
    const { email } = NOTIFICATION_CONFIG;
    
    if (!email.enabled || !email.smtpHost) {
      console.log('[NotificationService] Email disabled, skipping customer confirmation');
      return;
    }
    
    const items = Array.isArray(order.items) ? order.items : JSON.parse(order.items || '[]');
    const deliveryType = order.delivery_type === 'self' ? 'Самовывоз' : 'Доставка';
    const time = order.pickup_time || order.delivery_time || 'Как можно скорее';
    
    const subject = `Заказ #${order.order_number} принят`;
    const html = `
      <h2>Здравствуйте, ${order.customer_name}!</h2>
      <p>Ваш заказ принят и готовится.</p>
      
      <h3>Детали заказа:</h3>
      <p><b>Номер заказа:</b> ${order.order_number}</p>
      <p><b>Сумма:</b> ${order.total_amount} ₽</p>
      <p><b>Способ получения:</b> ${deliveryType}</p>
      <p><b>Время:</b> ${time}</p>
      
      <h3>Состав заказа:</h3>
      <ul>
        ${items.map(i => `<li>${i.name} × ${i.quantity} — ${(i.price * i.quantity).toFixed(2)} ₽</li>`).join('')}
      </ul>
      
      <p>Мы сообщим, когда заказ будет готов!</p>
    `;
    
    try {
      const nodemailer = require('nodemailer');
      
      const transporter = nodemailer.createTransport({
        host: email.smtpHost,
        port: parseInt(email.smtpPort) || 587,
        secure: email.smtpPort === '465',
        auth: {
          user: email.smtpUser,
          pass: email.smtpPass
        }
      });
      
      await transporter.sendMail({
        from: email.from || email.smtpUser,
        to: order.customer_email,
        subject: subject,
        html: html
      });
      
      console.log('[NotificationService] Customer confirmation sent to:', order.customer_email);
    } catch (error) {
      console.error('[NotificationService] Customer email error:', error.message);
      throw error;
    }
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
    
    // Send notifications to admin via all enabled channels
    NotificationService.notifyNewOrder(order).catch(e => console.error('[NotificationService]', e.message));
    
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

// Public order status by order_number
app.get('/api/orders/by-number/:orderNumber', async (req, res) => {
  try {
    const { orderNumber } = req.params;
    const { rows } = await pool.query(
      'SELECT id, order_number, status, total_amount, customer_name, created_at FROM orders WHERE order_number = $1',
      [orderNumber]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Заказ не найден' });
    }
    res.json(rows[0]);
  } catch (e) {
    console.error('Ошибка получения заказа:', e);
    res.status(500).json({ error: 'Ошибка получения заказа' });
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

app.put('/api/orders/:id/status', adminAuth, async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;
  
  const validStatuses = ['pending', 'paid', 'failed', 'ready', 'completed', 'cancelled'];
  if (!status || !validStatuses.includes(status)) {
    return res.status(400).json({ error: 'Некорректный статус' });
  }
  
  try {
    // Get current order status
    const { rows: orderRows } = await pool.query('SELECT * FROM orders WHERE id = $1', [id]);
    if (orderRows.length === 0) {
      return res.status(404).json({ error: 'Заказ не найден' });
    }
    
    const oldStatus = orderRows[0].status;
    
    // Skip notification if status hasn't changed
    if (oldStatus === status) {
      return res.json(orderRows[0]);
    }
    
    // Update order status
    const { rows } = await pool.query(
      'UPDATE orders SET status = $1 WHERE id = $2 RETURNING *',
      [status, id]
    );
    
    // Add to status history
    await pool.query(
      'INSERT INTO order_status_history (order_id, old_status, new_status, changed_by) VALUES ($1, $2, $3, $4)',
      [id, oldStatus, status, ADMIN_LOGIN]
    );
    
    // Send status change notification to admin
    NotificationService.notifyStatusChange(orderRows[0], oldStatus, status).catch(e => 
      console.error('[NotificationService] Status change notification error:', e.message)
    );
    
    res.json(rows[0]);
  } catch (e) {
    console.error('Ошибка обновления статуса заказа:', e);
    res.status(500).json({ error: 'Ошибка обновления статуса заказа' });
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

app.post('/api/payment/webhook', async (req, res) => {
  const { session_id, status, operation_id } = req.body;
  
  console.log('[PaymentWebhook] Received webhook:', req.body);
  
  if (!session_id) {
    return res.status(400).json({ error: 'session_id required' });
  }
  
  try {
    // Find order by session_id
    const { rows: orderRows } = await pool.query(
      'SELECT * FROM orders WHERE session_id = $1',
      [session_id]
    );
    
    if (orderRows.length === 0) {
      console.warn('[PaymentWebhook] Order not found for session:', session_id);
      return res.status(404).json({ error: 'Order not found' });
    }
    
    const order = orderRows[0];
    
    // Update payment status
    const newPaymentStatus = status === 'SUCCESS' ? 'paid' : status === 'FAILED' ? 'failed' : 'pending';
    const newOrderStatus = status === 'SUCCESS' ? 'paid' : status === 'FAILED' ? 'failed' : order.status;
    
    await pool.query(
      'UPDATE orders SET payment_status = $1, status = $2, payment_operation_id = $3 WHERE id = $4',
      [newPaymentStatus, newOrderStatus, operation_id, order.id]
    );
    
    // Send fiscal receipt on successful payment
    if (status === 'SUCCESS') {
      console.log('[PaymentWebhook] Payment successful, sending fiscal receipt...');
      
      try {
        const fiscalResult = await FiscalService.sendReceipt(order);
        
        if (fiscalResult.success) {
          await pool.query(
            'UPDATE orders SET receipt_id = $1, receipt_url = $2, fiscal_status = $3 WHERE id = $4',
            [fiscalResult.receiptId, fiscalResult.receiptUrl, 'sent', order.id]
          );
          console.log('[PaymentWebhook] Fiscal receipt sent successfully:', fiscalResult.receiptId);
        } else {
          await pool.query(
            'UPDATE orders SET fiscal_status = $2, fiscal_error = $3 WHERE id = $4',
            [order.id, 'error', fiscalResult.error]
          );
          console.error('[PaymentWebhook] Fiscal receipt failed:', fiscalResult.error);
        }
      } catch (fiscalError) {
        console.error('[PaymentWebhook] FiscalService error:', fiscalError.message);
        await pool.query(
          'UPDATE orders SET fiscal_status = $1, fiscal_error = $2 WHERE id = $3',
          ['error', fiscalError.message, order.id]
        );
      }
    }
    
    res.json({ ok: true });
  } catch (error) {
    console.error('[PaymentWebhook] Error processing webhook:', error);
    res.status(500).json({ error: 'Internal error' });
  }
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

// ── Fiscal API ───────────────────────────────────────────────────────────

/**
 * Webhook for receiving fiscal receipt status from cloud cash register
 * POST /api/fiscal/callback
 */
app.post('/api/fiscal/callback', async (req, res) => {
  const { receipt_id, external_id, status, error } = req.body;
  
  console.log('[FiscalCallback] Received callback:', req.body);
  
  if (!external_id) {
    return res.status(400).json({ error: 'external_id required' });
  }
  
  try {
    // Extract order ID from external_id (format: order_123)
    const orderId = parseInt(external_id.replace('order_', ''), 10);
    
    if (isNaN(orderId)) {
      console.error('[FiscalCallback] Invalid external_id:', external_id);
      return res.status(400).json({ error: 'Invalid external_id' });
    }
    
    // Update order with fiscal status
    const updates = [];
    const values = [];
    let paramIndex = 1;
    
    if (status) {
      updates.push(`fiscal_status = $${paramIndex++}`);
      values.push(status === 'completed' ? 'completed' : status);
    }
    
    if (error) {
      updates.push(`fiscal_error = $${paramIndex++}`);
      values.push(error);
    }
    
    if (receipt_id) {
      updates.push(`receipt_id = $${paramIndex++}`);
      values.push(receipt_id);
    }
    
    if (updates.length > 0) {
      values.push(orderId);
      await pool.query(
        `UPDATE orders SET ${updates.join(', ')} WHERE id = $${paramIndex}`,
        values
      );
      console.log('[FiscalCallback] Updated order:', orderId, 'status:', status);
    }
    
    res.json({ ok: true });
  } catch (error) {
    console.error('[FiscalCallback] Error processing callback:', error);
    res.status(500).json({ error: 'Internal error' });
  }
});

/**
 * Get receipt URL for an order
 * PUT /api/orders/:id/receipt
 */
app.put('/api/orders/:id/receipt', async (req, res) => {
  const { id } = req.params;
  
  try {
    const { rows } = await pool.query(
      'SELECT id, receipt_id, receipt_url, fiscal_status, fiscal_error FROM orders WHERE id = $1',
      [id]
    );
    
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Заказ не найден' });
    }
    
    const order = rows[0];
    
    // If no receipt exists, generate one
    if (!order.receipt_id && order.payment_status === 'paid') {
      console.log('[Receipt] Generating receipt for order:', id);
      
      const fiscalResult = await FiscalService.sendReceipt(order);
      
      if (fiscalResult.success) {
        await pool.query(
          'UPDATE orders SET receipt_id = $1, receipt_url = $2, fiscal_status = $3 WHERE id = $4',
          [fiscalResult.receiptId, fiscalResult.receiptUrl, 'sent', id]
        );
        
        order.receipt_id = fiscalResult.receiptId;
        order.receipt_url = fiscalResult.receiptUrl;
        order.fiscal_status = 'sent';
      }
    }
    
    // If we still don't have a receipt URL, try to check status
    if (!order.receipt_url && order.receipt_id) {
      const statusResult = await FiscalService.getReceiptStatus(order.receipt_id);
      console.log('[Receipt] Status check:', statusResult);
    }
    
    res.json({
      order_id: order.id,
      receipt_id: order.receipt_id,
      receipt_url: order.receipt_url,
      fiscal_status: order.fiscal_status,
      fiscal_error: order.fiscal_error
    });
  } catch (error) {
    console.error('[Receipt] Error getting receipt:', error);
    res.status(500).json({ error: 'Ошибка получения чека' });
  }
});

/**
 * Process refund and send refund receipt
 * POST /api/orders/:id/refund
 */
app.post('/api/orders/:id/refund', adminAuth, async (req, res) => {
  const { id } = req.params;
  const { amount, reason } = req.body;
  
  try {
    const { rows } = await pool.query('SELECT * FROM orders WHERE id = $1', [id]);
    
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Заказ не найден' });
    }
    
    const order = rows[0];
    
    if (order.payment_status !== 'paid') {
      return res.status(400).json({ error: 'Заказ не оплачен' });
    }
    
    const refundAmount = amount || order.total_amount;
    
    if (refundAmount > order.total_amount) {
      return res.status(400).json({ error: 'Сумма возврата превышает сумму заказа' });
    }
    
    // In production, process actual refund via payment provider
    // For now, just create fiscal refund receipt
    const fiscalResult = await FiscalService.sendRefundReceipt(order, refundAmount);
    
    if (fiscalResult.success) {
      await pool.query(
        `UPDATE orders SET 
          receipt_id = $1, 
          receipt_url = $2, 
          fiscal_status = 'refund_sent',
          fiscal_error = $3 
        WHERE id = $4`,
        [fiscalResult.receiptId, fiscalResult.receiptUrl, reason || null, id]
      );
    }
    
    res.json({
      success: true,
      refund_amount: refundAmount,
      receipt_id: fiscalResult.receiptId,
      receipt_url: fiscalResult.receiptUrl
    });
  } catch (error) {
    console.error('[Refund] Error processing refund:', error);
    res.status(500).json({ error: 'Ошибка обработки возврата' });
  }
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
