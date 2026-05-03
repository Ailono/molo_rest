# Дизайн: Корзина + самовывоз/доставка + оплата через Точка банк

## Обзор

Фича добавляет на сайт ресторана Molo (molobistro.ru) полный цикл онлайн-заказа с опциями самовывоза и доставки курьером:
выбор блюд из меню → корзина → форма оформления с выбором способа получения → создание заказа в БД → оплата через Точка банк → фискализация через облачную онлайн-кассу → уведомление в Telegram → управление заказами через админ-панель.

На период тестирования вся функциональность скрыта за feature flag `?preview=1`, который сохраняется в `sessionStorage`.

Стек остаётся неизменным: Node.js + Express, PostgreSQL (Neon), чистый HTML/CSS/JS без фреймворков.

---

## Архитектура

```
Браузер                          Сервер (Express)              Внешние сервисы
─────────────────────────────    ──────────────────────────    ─────────────────
cart.js (CartUI)
  ├─ feature flag (sessionStorage)
  ├─ состояние корзины (localStorage)
  ├─ модал корзины + форма заказа с выбором способа получения
  └─ POST /api/orders ──────────► OrderAPI (server.js)
                                    ├─ валидация тела запроса
                                    ├─ INSERT INTO orders
                                    ├─ PaymentService.createPayment() ──► Точка банк API
                                    ├─ FiscalService.sendReceipt() ─────► Облачная онлайн-касса
                                    └─ NotificationService.send()───────► Telegram Bot API
                                    └─ { order_id, payment_url } ◄──
  ◄─ { order_id, payment_url } ──
  └─ redirect / QR

menu.js (изменения)
  └─ renderDishes() добавляет кнопку «В корзину» если CartUI.isEnabled()

GET /api/orders (adminAuth) ─────► OrderAPI → SELECT * FROM orders ORDER BY created_at DESC
POST /api/payment/webhook ───────► PaymentService → обработка вебхуков от Точка банк
GET /admin/orders ──────────────► AdminPanel → админ-панель для управления заказами
POST /api/admin/settings ───────► AdminPanel → настройки доставки и работы ресторана
```

Взаимодействие между модулями строго однонаправленное: `menu.js` вызывает публичный API `CartUI`, `CartUI` делает HTTP-запросы к серверу, сервер не знает о клиентском коде.

---

## Компоненты и интерфейсы

### CartUI (`public/js/cart.js`)

Единственный глобальный объект `CartUI`, экспортируемый в `window`.

```js
window.CartUI = {
  // Инициализация: читает URL/sessionStorage, навешивает обработчики
  init(): void,

  // Возвращает true если feature flag активен
  isEnabled(): boolean,

  // Добавить блюдо в корзину (или увеличить qty на 1)
  addItem(dish: { id, name, price }): void,

  // Получить текущее состояние корзины
  getItems(): CartItem[],

  // Очистить корзину
  clear(): void,

  // Рассчитать стоимость доставки на основе суммы заказа
  calculateDelivery(subtotal: number): number,

  // Получить настройки доставки с сервера
  getDeliverySettings(): Promise<DeliverySettings>,
}
```

Внутренние методы (не экспортируются):
- `_loadFromStorage()` / `_saveToStorage()` — работа с localStorage
- `_renderModal()` — отрисовка содержимого модала корзины
- `_renderCounter()` — обновление счётчика в хедере
- `_openModal()` / `_closeModal()` — управление видимостью модала
- `_openOrderForm()` — переключение модала в режим формы заказа с выбором способа получения
- `_updateDeliveryForm()` — обновление формы в зависимости от выбранного способа получения
- `_submitOrder()` — отправка POST /api/orders
- `_validateOrderForm()` — валидация формы заказа

### Изменения в `menu.js`

В функции `renderDishes()` после создания `.body` добавляется кнопка «В корзину», если `window.CartUI?.isEnabled()` возвращает `true`:

```js
if (window.CartUI?.isEnabled()) {
  const btn = document.createElement('button');
  btn.className = 'btn-add-to-cart';
  btn.textContent = 'В корзину';
  btn.addEventListener('click', (e) => {
    e.stopPropagation(); // не открывать модал блюда
    window.CartUI.addItem({ id: d.id, name: d.name, price: d.price });
  });
  body.appendChild(btn);
}
```

`cart.js` подключается в `menu.html` **до** `menu.js`, чтобы `CartUI` был доступен при рендере карточек.

### OrderAPI (`server.js`)

Новые маршруты:

| Метод | Путь | Auth | Описание |
|---|---|---|---|
| POST | /api/orders | — | Создать заказ |
| GET | /api/orders | adminAuth | Список заказов |
| GET | /api/orders/:id | adminAuth | Получить детали заказа |
| PUT | /api/orders/:id/status | adminAuth | Изменить статус заказа |
| POST | /api/payment/webhook | — | Вебхук от Точка банк |
| GET | /api/settings/delivery | — | Получить настройки доставки |
| GET | /admin/orders | adminAuth | Админ-панель заказов |
| GET | /admin/orders/:id | adminAuth | Детали заказа в админке |
| POST | /api/admin/settings | adminAuth | Обновить настройки |

Тело POST /api/orders:
```json
{
  "customer_name": "string (required)",
  "customer_phone": "string (required)",
  "customer_email": "string (optional)",
  "delivery_type": "self" | "courier",
  "delivery_address": "string (required if delivery_type='courier')",
  "delivery_time": "string (required)",
  "delivery_comment": "string (optional)",
  "cutlery_count": "number (optional)",
  "items": [{ "dish_id": 1, "name": "Пицца", "price": 590, "quantity": 2 }],
  "subtotal_amount": 1180,
  "delivery_cost": 200,
  "total_amount": 1380
}
```

Ответ 201:
```json
{ 
  "order_id": 42, 
  "payment_url": "https://pay.tochka.com/session/abc123",
  "order_number": "MOLO-2025-0042"
}
```

### PaymentService (`server.js`)

Модуль для работы с эквайрингом Точка банк:

```js
class PaymentService {
  // Создать платежную сессию в Точка банк
  async createPayment(order) {
    const payload = {
      amount: order.total_amount * 100, // в копейках
      currency: "RUB",
      orderNumber: `MOLO-${order.id}`,
      description: `Заказ №${order.id} в Molo Bistro`,
      successUrl: `${process.env.BASE_URL}/order-success?order_id=${order.id}`,
      failUrl: `${process.env.BASE_URL}/order-failed?order_id=${order.id}`,
      customerEmail: order.customer_email,
      customerPhone: order.customer_phone
    };
    
    const response = await fetch('https://api.tochka.com/payments/v1/sessions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.TOCHKA_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });
    
    const data = await response.json();
    return {
      paymentUrl: data.paymentUrl,
      sessionId: data.sessionId
    };
  }
  
  // Обработать вебхук от Точка банк
  async handleWebhook(webhookData) {
    const { sessionId, status, amount } = webhookData;
    
    // Найти заказ по sessionId
    const order = await db.query('SELECT * FROM orders WHERE payment_session_id = $1', [sessionId]);
    
    if (status === 'SUCCESS') {
      await db.query(
        'UPDATE orders SET status = $1, payment_status = $2 WHERE id = $3',
        ['paid', 'completed', order.id]
      );
      
      // Отправить в онлайн-кассу и получить ссылку на чек
      const fiscalResult = await FiscalService.sendReceipt(order);
      
      // Сохранить ссылку на фискальный чек
      if (fiscalResult.receiptUrl) {
        await db.query(
          'UPDATE orders SET fiscal_receipt_url = $1 WHERE id = $2',
          [fiscalResult.receiptUrl, order.id]
        );
        
        // Отправить чек клиенту на email
        await NotificationService.sendCustomerReceipt({...order, fiscal_receipt_url: fiscalResult.receiptUrl});
      }
      
      // Отправить уведомление об оплате
      await NotificationService.sendPaymentNotification(order);
    } else if (status === 'FAILED') {
      await db.query(
        'UPDATE orders SET payment_status = $1 WHERE id = $2',
        ['failed', order.id]
      );
    }
  }
}
```

### NotificationService (`server.js`)

```js
class NotificationService {
  constructor() {
    this.channels = this.loadChannels();
  }
  
  // Загрузить настроенные каналы уведомлений
  loadChannels() {
    const channels = [];
    
    // Telegram channel
    if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) {
      channels.push({
        name: 'telegram',
        enabled: true,
        send: this.sendTelegram.bind(this)
      });
    }
    
    // Max channel (мессенджер от VK)
    if (process.env.MAX_API_TOKEN && process.env.MAX_CHAT_ID) {
      channels.push({
        name: 'max',
        enabled: true,
        send: this.sendMax.bind(this)
      });
    }
    
    // Email channel для администраторов
    if (process.env.ADMIN_EMAIL) {
      channels.push({
        name: 'email',
        enabled: true,
        send: this.sendEmail.bind(this)
      });
    }
    
    return channels;
  }
  
  // Отправить уведомление о новом заказе через все каналы
  async sendOrderNotification(order) {
    const message = this.formatOrderMessage(order);
    const promises = this.channels
      .filter(channel => channel.enabled)
      .map(channel => 
        channel.send(message, order).catch(error => {
          console.error(`[NotificationService] Ошибка отправки через ${channel.name}:`, error.message);
          return null;
        })
      );
    
    // Добавляем отправку email клиенту
    if (order.customer_email) {
      promises.push(
        this.sendCustomerConfirmation(order).catch(error => {
          console.error('[NotificationService] Ошибка отправки email клиенту:', error.message);
          return null;
        })
      );
    }
    
    await Promise.all(promises);
  }
  
  // Отправить уведомление об оплате
  async sendPaymentNotification(order) {
    const message = `💳 *ОПЛАЧЕНО* Заказ #${order.id}\n` +
                   `Сумма: ${order.total_amount} ₽\n` +
                   `Клиент: ${order.customer_name}\n` +
                   `Телефон: ${order.customer_phone}`;
    
    const promises = this.channels
      .filter(channel => channel.enabled && channel.name !== 'email') // Email не для оплаты
      .map(channel => 
        channel.send(message, order).catch(error => {
          console.error(`[NotificationService] Ошибка отправки уведомления об оплате через ${channel.name}:`, error.message);
          return null;
        })
      );
    
    await Promise.all(promises);
  }
  
  // Telegram отправка
  async sendTelegram(message, order) {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        chat_id: chatId, 
        text: message, 
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [[
            { text: '✅ Взять в работу', callback_data: `order_${order.id}_take` },
            { text: '👁️ Посмотреть', url: `${process.env.BASE_URL}/admin/orders/${order.id}` }
          ]]
        }
      })
    });
  }
  
  // Max отправка (мессенджер от VK)
  async sendMax(message, order) {
    const apiToken = process.env.MAX_API_TOKEN;
    const chatId = process.env.MAX_CHAT_ID;
    
    // Max API обычно использует VK API для отправки сообщений
    // Пример для Max (через VK API)
    await fetch('https://api.vk.com/method/messages.send', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        access_token: apiToken,
        peer_id: chatId,
        message: message,
        random_id: Math.floor(Math.random() * 1000000),
        v: '5.199' // версия API
      })
    });
  }
  
  // Email отправка администраторам
  async sendEmail(message, order) {
    const adminEmail = process.env.ADMIN_EMAIL;
    const subject = `Новый заказ #${order.id} в Molo Bistro`;
    
    // Используем nodemailer или другой email клиент
    const transporter = nodemailer.createTransport({
      // настройки SMTP
    });
    
    await transporter.sendMail({
      from: process.env.SMTP_FROM,
      to: adminEmail,
      subject: subject,
      text: message,
      html: `<pre>${message}</pre>`
    });
  }
  
  // Отправить email подтверждения клиенту
  async sendCustomerConfirmation(order) {
    if (!order.customer_email) return;
    
    const transporter = nodemailer.createTransport({
      // настройки SMTP
    });
    
    const emailContent = this.formatCustomerEmail(order);
    
    await transporter.sendMail({
      from: process.env.SMTP_FROM,
      to: order.customer_email,
      subject: `Подтверждение заказа #${order.id} в Molo Bistro`,
      text: emailContent.text,
      html: emailContent.html
    });
  }
  
  // Отправить email с фискальным чеком клиенту
  async sendCustomerReceipt(order) {
    if (!order.customer_email || !order.fiscal_receipt_url) return;
    
    const transporter = nodemailer.createTransport({
      // настройки SMTP
    });
    
    await transporter.sendMail({
      from: process.env.SMTP_FROM,
      to: order.customer_email,
      subject: `Чек по заказу #${order.id} в Molo Bistro`,
      text: `Ваш чек доступен по ссылке: ${order.fiscal_receipt_url}`,
      html: `
        <h2>Чек по заказу #${order.id}</h2>
        <p>Спасибо за заказ в Molo Bistro!</p>
        <p>Ваш фискальный чек доступен по ссылке: <a href="${order.fiscal_receipt_url}">${order.fiscal_receipt_url}</a></p>
        <p>Сумма: ${order.total_amount} ₽</p>
        <p>Дата: ${new Date(order.created_at).toLocaleString('ru-RU')}</p>
      `
    });
  }
  
  // Отправить уведомление клиенту о готовности/доставке
  async sendCustomerStatusUpdate(order, status) {
    if (!order.customer_email) return;
    
    const transporter = nodemailer.createTransport({
      // настройки SMTP
    });
    
    let subject, message;
    
    switch(status) {
      case 'ready':
        subject = `Заказ #${order.id} готов к выдаче`;
        message = `Ваш заказ #${order.id} готов к самовывозу.`;
        if (order.delivery_type === 'courier') {
          message = `Ваш заказ #${order.id} готов к доставке. Курьер выедет в ближайшее время.`;
        }
        break;
      case 'delivered':
        subject = `Заказ #${order.id} доставлен`;
        message = `Ваш заказ #${order.id} успешно доставлен. Приятного аппетита!`;
        break;
      case 'picked_up':
        subject = `Заказ #${order.id} получен`;
        message = `Спасибо, что выбрали Molo Bistro! Ваш заказ #${order.id} получен.`;
        break;
      default:
        return;
    }
    
    await transporter.sendMail({
      from: process.env.SMTP_FROM,
      to: order.customer_email,
      subject: subject,
      text: message,
      html: `<p>${message}</p>`
    });
  }
  
  // Форматировать email для клиента
  formatCustomerEmail(order) {
    const deliveryType = order.delivery_type === 'self' ? 'Самовывоз' : 'Доставка курьером';
    const deliveryInfo = order.delivery_type === 'courier' ? 
      `<p><strong>Адрес доставки:</strong> ${order.delivery_address}</p>
       <p><strong>Время доставки:</strong> ${order.delivery_time}</p>` : 
      `<p><strong>Время самовывоза:</strong> ${order.delivery_time}</p>`;
    
    let itemsHtml = '<table style="width:100%; border-collapse: collapse; margin: 20px 0;">';
    itemsHtml += '<tr style="background-color: #f2f2f2;"><th style="padding: 10px; text-align: left;">Блюдо</th><th style="padding: 10px; text-align: left;">Кол-во</th><th style="padding: 10px; text-align: left;">Цена</th><th style="padding: 10px; text-align: left;">Сумма</th></tr>';
    
    JSON.parse(order.items).forEach(item => {
      itemsHtml += `
        <tr>
          <td style="padding: 10px; border-bottom: 1px solid #ddd;">${item.name}</td>
          <td style="padding: 10px; border-bottom: 1px solid #ddd;">${item.quantity}</td>
          <td style="padding: 10px; border-bottom: 1px solid #ddd;">${item.price} ₽</td>
          <td style="padding: 10px; border-bottom: 1px solid #ddd;">${item.price * item.quantity} ₽</td>
        </tr>
      `;
    });
    
    itemsHtml += '</table>';
    
    const html = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h1 style="color: #333;">Подтверждение заказа #${order.id}</h1>
        <p>Здравствуйте, ${order.customer_name}!</p>
        <p>Благодарим за заказ в Molo Bistro.</p>
        
        <h2 style="color: #555;">Детали заказа</h2>
        <p><strong>Номер заказа:</strong> ${order.id}</p>
        <p><strong>Имя:</strong> ${order.customer_name}</p>
        <p><strong>Телефон:</strong> ${order.customer_phone}</p>
        <p><strong>Способ получения:</strong> ${deliveryType}</p>
        ${deliveryInfo}
        
        <h2 style="color: #555;">Состав заказа</h2>
        ${itemsHtml}
        
        <div style="background-color: #f9f9f9; padding: 15px; border-radius: 5px; margin-top: 20px;">
          <p><strong>Сумма заказа:</strong> ${order.subtotal_amount} ₽</p>
          ${order.delivery_cost > 0 ? `<p><strong>Доставка:</strong> ${order.delivery_cost} ₽</p>` : '<p><strong>Доставка:</strong> бесплатно</p>'}
          <p style="font-size: 18px; font-weight: bold;"><strong>Итого к оплате:</strong> ${order.total_amount} ₽</p>
        </div>
        
        <p style="margin-top: 30px;">Вы можете отслеживать статус заказа по ссылке: 
          <a href="${process.env.BASE_URL}/order-status?order_id=${order.id}">${process.env.BASE_URL}/order-status?order_id=${order.id}</a>
        </p>
        
        <p style="margin-top: 20px; color: #666;">
          С уважением,<br>
          Команда Molo Bistro
        </p>
      </div>
    `;
    
    const text = `Подтверждение заказа #${order.id}
Здравствуйте, ${order.customer_name}!
Благодарим за заказ в Molo Bistro.

Детали заказа:
Номер заказа: ${order.id}
Имя: ${order.customer_name}
Телефон: ${order.customer_phone}
Способ получения: ${deliveryType}
${order.delivery_type === 'courier' ? `Адрес доставки: ${order.delivery_address}\nВремя доставки: ${order.delivery_time}` : `Время самовывоза: ${order.delivery_time}`}

Состав заказа:
${JSON.parse(order.items).map(item => `${item.name} x${item.quantity} = ${item.price * item.quantity} ₽`).join('\n')}

Сумма заказа: ${order.subtotal_amount} ₽
${order.delivery_cost > 0 ? `Доставка: ${order.delivery_cost} ₽` : 'Доставка: бесплатно'}
Итого к оплате: ${order.total_amount} ₽

Отслеживать статус заказа: ${process.env.BASE_URL}/order-status?order_id=${order.id}

С уважением,
Команда Molo Bistro`;
    
    return { html, text };
  }
  
  // Форматировать сообщение о заказе
  formatOrderMessage(order) {
    const deliveryType = order.delivery_type === 'self' ? 'Самовывоз' : 'Доставка курьером';
    const deliveryInfo = order.delivery_type === 'courier' ? 
      `🏠 Адрес: ${order.delivery_address}\n` +
      `⏰ Время: ${order.delivery_time}\n` +
      (order.delivery_comment ? `💬 Комментарий: ${order.delivery_comment}\n` : '') : 
      `⏰ Время самовывоза: ${order.delivery_time}\n`;
    
    let itemsText = '';
    JSON.parse(order.items).forEach(item => {
      itemsText += `• ${item.name} x${item.quantity} = ${item.price * item.quantity} ₽\n`;
    });
    
    return `🆕 *НОВЫЙ ЗАКАЗ* #${order.id}\n` +
           `👤 Клиент: ${order.customer_name}\n` +
           `📞 Телефон: ${order.customer_phone}\n` +
           (order.customer_email ? `📧 Email: ${order.customer_email}\n` : '') +
           `🚚 Способ: ${deliveryType}\n` +
           deliveryInfo +
           (order.cutlery_count ? `🍴 Приборы: ${order.cutlery_count} шт.\n` : '') +
           `\n📦 *Состав заказа:*\n${itemsText}\n` +
           `💰 Сумма: ${order.subtotal_amount} ₽\n` +
           (order.delivery_cost > 0 ? `🚚 Доставка: ${order.delivery_cost} ₽\n` : '🚚 Доставка: бесплатно\n') +
           `💵 *Итого: ${order.total_amount} ₽*\n` +
           `💳 Статус оплаты: ${order.payment_status || 'ожидает оплаты'}`;
  }
}
```

### Страница `public/order-success.html`

Статическая страница, отображаемая после оформления заказа. Читает `order_id` из query string (`?order_id=42`) и показывает подтверждение. Использует существующий `style.css` и шапку сайта.

---

## Модели данных

### CartItem (localStorage)

```ts
interface CartItem {
  id: number;       // dish.id из БД
  name: string;     // название блюда
  price: number;    // цена за единицу
  quantity: number; // количество
}
```

Хранится в `localStorage` под ключом `molo_cart` как JSON-массив.

### Order (таблица `orders`)

```sql
CREATE TABLE IF NOT EXISTS orders (
  id                SERIAL PRIMARY KEY,
  order_number      TEXT UNIQUE, -- формат: MOLO-YYYY-NNNN
  customer_name     TEXT    NOT NULL,
  customer_phone    TEXT    NOT NULL,
  customer_email    TEXT,
  delivery_type     TEXT    NOT NULL DEFAULT 'self', -- 'self' или 'courier'
  delivery_address  TEXT,
  delivery_time     TEXT    NOT NULL,
  delivery_comment  TEXT,
  delivery_cost     REAL    NOT NULL DEFAULT 0,
  cutlery_count     INTEGER DEFAULT 0,
  items             JSONB   NOT NULL,
  subtotal_amount   REAL    NOT NULL,
  total_amount      REAL    NOT NULL,
  status            TEXT    NOT NULL DEFAULT 'pending', -- pending, paid, preparing, ready, delivered, picked_up, cancelled
  payment_status    TEXT    DEFAULT 'pending', -- pending, completed, failed, refunded
  payment_url       TEXT,
  payment_session_id TEXT,
  fiscal_receipt_url TEXT,
  fiscal_receipt_id  TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS order_status_history (
  id         SERIAL PRIMARY KEY,
  order_id   INTEGER REFERENCES orders(id) ON DELETE CASCADE,
  status     TEXT NOT NULL,
  changed_by TEXT, -- user_id или 'system'
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS settings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  description TEXT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Настройки по умолчанию
INSERT INTO settings (key, value, description) VALUES
('delivery_free_threshold', '1500', 'Минимальная сумма для бесплатной доставки'),
('delivery_cost', '200', 'Стоимость доставки при заказе меньше порога'),
('restaurant_open_time', '11:00', 'Время открытия ресторана'),
('restaurant_close_time', '23:00', 'Время закрытия ресторана'),
('preparation_time_minutes', '30', 'Стандартное время приготовления')
ON CONFLICT (key) DO NOTHING;
```

Миграция добавляется в `initDB()` через `CREATE TABLE IF NOT EXISTS` — идемпотентно.

### Feature Flag

```
sessionStorage key: 'molo_preview'
value: '1' (string) или отсутствует
```

Логика активации:
1. Если в URL есть `?preview=1` → записать `'1'` в `sessionStorage['molo_preview']`
2. Если `sessionStorage['molo_preview'] === '1'` → флаг активен
3. Иначе → флаг неактивен, элементы корзины скрыты

---

## Correctness Properties

*A property is a characteristic or behavior that should hold true across all valid executions of a system — essentially, a formal statement about what the system should do. Properties serve as the bridge between human-readable specifications and machine-verifiable correctness guarantees.*

### Property 1: Feature flag управляет видимостью

*For any* состояния страницы меню: если `sessionStorage['molo_preview']` не равен `'1'` и URL не содержит `?preview=1`, то `CartUI.isEnabled()` должен возвращать `false`, а все DOM-элементы корзины должны иметь `display: none` или отсутствовать в DOM.

**Validates: Requirements 1.1, 1.4**

### Property 2: Feature flag сохраняется в sessionStorage

*For any* URL, содержащего параметр `?preview=1`, после вызова `CartUI.init()` значение `sessionStorage.getItem('molo_preview')` должно быть равно `'1'`.

**Validates: Requirements 1.2, 1.3**

### Property 3: Добавление нового блюда устанавливает quantity = 1

*For any* блюда, которого нет в корзине, после вызова `CartUI.addItem(dish)` элемент корзины с `id === dish.id` должен иметь `quantity === 1`.

**Validates: Requirements 2.1**

### Property 4: Повторное добавление увеличивает quantity на 1

*For any* блюда, уже находящегося в корзине с `quantity = N`, после вызова `CartUI.addItem(dish)` его `quantity` должно стать `N + 1`.

**Validates: Requirements 2.2**

### Property 5: Корзина round-trip через localStorage

*For any* состояния корзины (произвольный массив CartItem), после сохранения в localStorage и последующего вызова `_loadFromStorage()` полученный массив должен быть глубоко равен исходному.

**Validates: Requirements 2.3, 2.4**

### Property 6: Счётчик корзины равен сумме количеств

*For any* состояния корзины, числовое значение счётчика в хедере должно быть равно `items.reduce((s, i) => s + i.quantity, 0)`. При пустой корзине счётчик равен 0.

**Validates: Requirements 2.5, 2.6**

### Property 7: Рендер позиции содержит все обязательные поля

*For any* CartItem, HTML-разметка, генерируемая для этой позиции в модале корзины, должна содержать: название блюда, цену за единицу, текущее количество и сумму по позиции (`price * quantity`).

**Validates: Requirements 3.2**

### Property 8: Итоговая сумма корзины равна сумме произведений

*For any* состояния корзины, отображаемая итоговая сумма должна быть равна `items.reduce((s, i) => s + i.price * i.quantity, 0)`.

**Validates: Requirements 3.3**

### Property 9: Уменьшение quantity до 0 удаляет позицию

*For any* CartItem с `quantity = 1`, после нажатия кнопки уменьшения (или вызова внутреннего метода декремента) этот item должен отсутствовать в `CartUI.getItems()`.

**Validates: Requirements 3.5, 3.6**

### Property 10: Валидация обязательных полей формы

*For any* комбинации значений полей формы, где `customer_name` или `customer_phone` пусты (пустая строка или строка из пробелов), функция валидации должна возвращать `false` и форма не должна отправляться.

**Validates: Requirements 4.3**

### Property 11: Валидация формата телефона

*For any* строки `phone`: функция `validatePhone(phone)` должна возвращать `true` тогда и только тогда, когда строка имеет длину от 10 до 15 символов и содержит только символы из множества `[0-9 \-\(\)\+]`.

**Validates: Requirements 4.4**

### Property 12: Валидация формата email

*For any* непустой строки `email`: функция `validateEmail(email)` должна возвращать `false`, если строка не содержит символ `@` или не имеет домена после `@`.

**Validates: Requirements 4.5**

### Property 13: Создание заказа возвращает order_id со статусом pending

*For any* валидного тела запроса POST /api/orders, ответ должен содержать `order_id` (целое число > 0), а запись в таблице `orders` с этим `id` должна иметь `status = 'pending'`.

**Validates: Requirements 5.1, 6.4**

### Property 14: Создание заказа возвращает payment_url

*For any* валидного тела запроса POST /api/orders, ответ должен содержать поле `payment_url` в виде непустой строки.

**Validates: Requirements 5.2**

### Property 15: SBP_Stub формирует корректный URL

*For any* целого числа `orderId > 0`, функция `getSbpPaymentUrl(orderId)` должна возвращать строку, соответствующую шаблону `https://sbp.stub/pay/{orderId}`.

**Validates: Requirements 5.3**

### Property 16: Корзина очищается после успешного заказа

*For any* непустого состояния корзины, после успешного ответа POST /api/orders вызов `CartUI.getItems()` должен возвращать пустой массив, а `localStorage.getItem('molo_cart')` должен быть `null` или `'[]'`.

**Validates: Requirements 5.6**

### Property 17: Состав заказа round-trip через JSONB

*For any* массива CartItem, переданного в POST /api/orders как `items`, после сохранения в БД и чтения через GET /api/orders поле `items` должно быть глубоко равно исходному массиву.

**Validates: Requirements 6.2**

### Property 18: Инварианты полей нового заказа

*For any* созданного заказа, поле `pickup_type` должно быть равно `'self'`, а поле `status` — `'pending'`.

**Validates: Requirements 6.3, 6.4**

### Property 19: Список заказов отсортирован по created_at DESC

*For any* набора заказов в БД, ответ GET /api/orders должен возвращать массив, в котором `orders[i].created_at >= orders[i+1].created_at` для всех `i`.

**Validates: Requirements 6.5**

### Property 20: Уведомление отправляется для каждого заказа

*For any* успешно созданного заказа (при наличии `TELEGRAM_BOT_TOKEN` и `TELEGRAM_CHAT_ID`), функция `sendTelegramNotification` должна быть вызвана ровно один раз с объектом этого заказа.

**Validates: Requirements 7.1**

### Property 21: Сообщение уведомления содержит все обязательные поля

*For any* объекта заказа, строка, возвращаемая `formatOrderMessage(order)`, должна содержать: номер заказа (`order.id`), имя клиента (`customer_name`), телефон (`customer_phone`), каждую позицию заказа (название и количество) и итоговую сумму (`total_amount`).

**Validates: Requirements 7.2**

### Property 22: Расчет стоимости доставки на основе порога

*For any* суммы заказа (`subtotal_amount`), функция `calculateDelivery(subtotal)` должна возвращать `0` если `subtotal >= delivery_free_threshold`, иначе возвращать `delivery_cost`.

**Validates: Requirements 4.5**

### Property 23: Валидация обязательных полей для доставки

*For any* заказа с `delivery_type = 'courier'`, функция валидации должна возвращать `false` если `delivery_address` пустое, иначе возвращать `true`.

**Validates: Requirements 4.4**

### Property 24: Генерация номера заказа в формате MOLO-YYYY-NNNN

*For any* созданного заказа, поле `order_number` должно соответствовать формату `MOLO-{год}-{порядковый номер с ведущими нулями}`.

**Validates: Requirements 6.1**

### Property 25: Интеграция с Точка банк возвращает payment_url

*For any* валидного заказа, вызов `PaymentService.createPayment(order)` должен возвращать объект с полями `paymentUrl` (непустая строка) и `sessionId` (непустая строка).

**Validates: Requirements 5.2, 5.3**

### Property 26: Обновление статуса при получении вебхука

*For any* вебхука от Точка банк со статусом `SUCCESS`, функция `PaymentService.handleWebhook(webhookData)` должна обновить статус заказа на `paid` и `payment_status` на `completed`.

**Validates: Requirements 5.5**

### Property 27: Фискализация при успешной оплате

*For any* заказа со статусом `paid`, функция `FiscalService.sendReceipt(order)` должна быть вызвана ровно один раз.

**Validates: Requirements 5.6**

### Property 28: Админ-панель фильтрует заказы по статусу

*For any* набора заказов с разными статусами, запрос GET /admin/orders с параметром `status` должен возвращать только заказы с указанным статусом.

**Validates: Requirements 8.3**

### Property 29: История статусов заказа

*For any* изменения статуса заказа, в таблице `order_status_history` должна создаваться запись с `order_id`, новым статусом и временем изменения.

**Validates: Requirements 8.7**

### Property 30: Экспорт заказов в CSV

*For any* набора заказов, функция экспорта должна генерировать CSV файл с колонками: номер заказа, имя клиента, телефон, сумма, статус, время создания.

**Validates: Requirements 8.9**

### Property 31: Мультиканальные уведомления отправляются через все настроенные каналы

*For any* созданного заказа и *for any* набора включенных каналов уведомлений, функция `NotificationService.sendOrderNotification(order)` должна отправить сообщение через каждый включенный канал.

**Validates: Requirements 7.1, 7.2**

### Property 32: Ошибка в одном канале не прерывает отправку через другие каналы

*For any* созданного заказа и *for any* канала, который возвращает ошибку, остальные каналы должны получить уведомление, а ошибка должна быть записана в лог.

**Validates: Requirements 7.4**

### Property 33: Уведомления отправляются при изменении статуса оплаты

*For any* заказа, статус которого меняется на `paid`, функция `NotificationService.sendPaymentNotification(order)` должна быть вызвана через все настроенные каналы (кроме email).

**Validates: Requirements 7.7**

### Property 34: Email подтверждения отправляется клиенту при создании заказа

*For any* заказа с указанным email клиента, функция `NotificationService.sendCustomerConfirmation(order)` должна быть вызвана ровно один раз.

**Validates: Requirements 7.11**

### Property 35: Фискальный чек отправляется клиенту после оплаты

*For any* оплаченного заказа с фискальным чеком и email клиента, функция `NotificationService.sendCustomerReceipt(order)` должна быть вызвана ровно один раз.

**Validates: Requirements 7.13**

### Property 36: Email уведомления содержат все обязательные поля

*For any* заказа, email подтверждения должен содержать: номер заказа, имя клиента, состав заказа, итоговую сумму, способ получения и ссылку на статус заказа.

**Validates: Requirements 7.12**

### Property 37: Уведомления о готовности/доставке отправляются клиенту

*For any* заказа, статус которого меняется на `ready` или `delivered` с указанным email клиента, функция `NotificationService.sendCustomerStatusUpdate(order, status)` должна быть вызвана.

**Validates: Requirements 7.14**

---

## Обработка ошибок

| Ситуация | Поведение |
|---|---|
| POST /api/orders — отсутствуют обязательные поля | HTTP 400, `{ error: "..." }` |
| POST /api/orders — ошибка INSERT в БД | HTTP 500, `{ error: "..." }`, PaymentService не вызывается |
| Telegram Bot API недоступен или вернул ошибку | Лог ошибки на сервере, клиент получает 201 (заказ создан) |
| `TELEGRAM_BOT_TOKEN` не задан | Предупреждение в лог, уведомление пропускается |
| `TELEGRAM_CHAT_ID` не задан | Предупреждение в лог, уведомление пропускается |
| `TOCHKA_API_KEY` не задан | HTTP 500, `{ error: "Payment service unavailable" }` |
| Точка банк API недоступен | HTTP 500, `{ error: "Payment service temporarily unavailable" }` |
| Облачная онлайн-касса недоступна | Лог ошибки, заказ создается, фискализация откладывается |
| localStorage недоступен (приватный режим) | CartUI работает только в памяти, без персистентности |
| Пользователь открывает order-success.html без `?order_id` | Показывается общее сообщение «Заказ оформлен» без номера |
| Время доставки/самовывоза вне рабочего времени | HTTP 400, `{ error: "Selected time is outside working hours" }` |
| Сумма заказа меньше минимальной (если настроено) | HTTP 400, `{ error: "Order amount is below minimum" }` |
| Ошибка вебхука от Точка банк | Лог ошибки, повторная попытка через 5 минут |
| Ошибка фискализации | Лог ошибки, повторная попытка через 10 минут |

Клиентские ошибки валидации формы отображаются inline рядом с полем, не через `alert()`.

---

## Стратегия тестирования

### Подход

Используется двойная стратегия: **unit-тесты** для конкретных примеров и граничных случаев, **property-based тесты** для универсальных свойств.

### Инструменты

- **Property-based testing**: [fast-check](https://github.com/dubzzz/fast-check) (JavaScript/Node.js)
- **Unit/integration тесты**: [Vitest](https://vitest.dev/) (совместим с Node.js, без браузера)
- Минимум **100 итераций** на каждый property-тест (fast-check по умолчанию: 100)

### Unit-тесты (конкретные примеры и граничные случаи)

- Открытие модала корзины по клику на иконку (Requirement 3.1)
- Отображение «Корзина пуста» при пустой корзине (Requirement 3.7)
- Отображение формы заказа при нажатии «Оформить заказ» (Requirement 4.1)
- Тип получения «Самовывоз» выбран по умолчанию (Requirement 4.2)
- Редирект на `payment_url` после успешного создания заказа (Requirement 5.4)
- HTTP 500 при ошибке БД в POST /api/orders (Requirement 5.5)
- Таблица `orders` создаётся при инициализации БД (Requirement 6.1)
- Telegram-уведомление не прерывает ответ при ошибке Bot API (Requirement 7.3)
- Уведомление пропускается при отсутствии `TELEGRAM_BOT_TOKEN` (Requirement 7.4)

### Property-тесты

Каждый тест помечается комментарием в формате:
`// Feature: cart-and-pickup-payment, Property N: <текст свойства>`

```
Property 1  — fc.boolean() для флага, проверка CartUI.isEnabled() и DOM
Property 2  — fc.constant('?preview=1'), проверка sessionStorage после init()
Property 3  — fc.record({ id, name, price }), проверка quantity === 1
Property 4  — fc.record + fc.integer({ min: 1 }), проверка quantity = N+1
Property 5  — fc.array(CartItem), round-trip через JSON.parse(JSON.stringify())
Property 6  — fc.array(CartItem), проверка sum(qty) === counter value
Property 7  — fc.record(CartItem), проверка наличия полей в HTML-строке
Property 8  — fc.array(CartItem), проверка total === sum(price*qty)
Property 9  — fc.record(CartItem, { quantity: 1 }), проверка отсутствия после декремента
Property 10 — fc.record({ name: fc.string(), phone: fc.string() }), проверка валидации
Property 11 — fc.string(), проверка validatePhone() против regex
Property 12 — fc.string(), проверка validateEmail() против regex
Property 13 — fc.record(validOrderBody), проверка order_id > 0 и status='pending' в БД
Property 14 — fc.record(validOrderBody), проверка наличия payment_url в ответе
Property 15 — fc.integer({ min: 1 }), проверка формата URL
Property 16 — fc.array(CartItem, { minLength: 1 }), проверка пустой корзины после заказа
Property 17 — fc.array(CartItem), round-trip items через БД
Property 18 — fc.record(validOrderBody), проверка delivery_type и status='pending'
Property 19 — fc.array(validOrderBody, { minLength: 2 }), проверка сортировки
Property 20 — fc.record(validOrderBody), проверка вызова mock Telegram API
Property 21 — fc.record(Order), проверка наличия всех полей в formatOrderMessage()
Property 22 — fc.float({ min: 0 }), проверка расчета стоимости доставки
Property 23 — fc.record({ delivery_type: fc.constant('courier'), delivery_address: fc.string() }), проверка валидации
Property 24 — fc.record(validOrderBody), проверка формата order_number
Property 25 — fc.record(validOrderBody), проверка интеграции с Точка банк
Property 26 — fc.record({ sessionId: fc.string(), status: fc.constant('SUCCESS') }), проверка обработки вебхука
Property 27 — fc.record(Order, { status: fc.constant('paid') }), проверка фискализации
Property 28 — fc.array(validOrderBody, { minLength: 3 }), проверка фильтрации в админке
Property 29 — fc.record({ order_id: fc.integer({ min: 1 }), status: fc.string() }), проверка истории статусов
Property 30 — fc.array(validOrderBody, { minLength: 1 }), проверка экспорта в CSV
```
