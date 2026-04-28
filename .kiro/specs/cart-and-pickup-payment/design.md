# Дизайн: Корзина + самовывоз + оплата через СБП

## Обзор

Фича добавляет на сайт ресторана Molo (molobistro.ru) полный цикл онлайн-заказа с самовывозом:
выбор блюд из меню → корзина → форма оформления → создание заказа в БД → редирект на оплату СБП → уведомление в Telegram.

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
  ├─ модал корзины + форма заказа
  └─ POST /api/orders ──────────► OrderAPI (server.js)
                                    ├─ валидация тела запроса
                                    ├─ INSERT INTO orders
                                    ├─ SBP_Stub.getPaymentUrl()
                                    └─ NotificationService.send()──► Telegram Bot API
                                    └─ { order_id, payment_url } ◄──
  ◄─ { order_id, payment_url } ──
  └─ redirect / QR

menu.js (изменения)
  └─ renderDishes() добавляет кнопку «В корзину» если CartUI.isEnabled()

GET /api/orders (adminAuth) ─────► OrderAPI → SELECT * FROM orders ORDER BY created_at DESC
POST /api/payment/webhook ───────► заглушка, возвращает 200 OK
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
}
```

Внутренние методы (не экспортируются):
- `_loadFromStorage()` / `_saveToStorage()` — работа с localStorage
- `_renderModal()` — отрисовка содержимого модала корзины
- `_renderCounter()` — обновление счётчика в хедере
- `_openModal()` / `_closeModal()` — управление видимостью модала
- `_openOrderForm()` — переключение модала в режим формы заказа
- `_submitOrder()` — отправка POST /api/orders

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

Три новых маршрута:

| Метод | Путь | Auth | Описание |
|---|---|---|---|
| POST | /api/orders | — | Создать заказ |
| GET | /api/orders | adminAuth | Список заказов |
| POST | /api/payment/webhook | — | Вебхук банка (заглушка) |

Тело POST /api/orders:
```json
{
  "customer_name": "string (required)",
  "customer_phone": "string (required)",
  "customer_email": "string (optional)",
  "items": [{ "dish_id": 1, "name": "Пицца", "price": 590, "quantity": 2 }],
  "total_amount": 1180
}
```

Ответ 201:
```json
{ "order_id": 42, "payment_url": "https://sbp.stub/pay/42" }
```

### SBP_Stub

Встроенная функция в `server.js`, не выделяется в отдельный файл:

```js
function getSbpPaymentUrl(orderId) {
  return `https://sbp.stub/pay/${orderId}`;
}
```

При реальной интеграции заменяется на HTTP-запрос к эквайеру без изменения остального кода.

### NotificationService (`server.js`)

```js
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
```

Вызывается **после** успешного INSERT, ошибка не прерывает ответ клиенту.

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
  id             SERIAL PRIMARY KEY,
  customer_name  TEXT    NOT NULL,
  customer_phone TEXT    NOT NULL,
  customer_email TEXT,
  items          JSONB   NOT NULL,
  total_amount   REAL    NOT NULL,
  pickup_type    TEXT    NOT NULL DEFAULT 'self',
  status         TEXT    NOT NULL DEFAULT 'pending',
  payment_url    TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
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

---

## Обработка ошибок

| Ситуация | Поведение |
|---|---|
| POST /api/orders — отсутствуют обязательные поля | HTTP 400, `{ error: "..." }` |
| POST /api/orders — ошибка INSERT в БД | HTTP 500, `{ error: "..." }`, SBP_Stub не вызывается |
| Telegram Bot API недоступен или вернул ошибку | Лог ошибки на сервере, клиент получает 201 (заказ создан) |
| `TELEGRAM_BOT_TOKEN` не задан | Предупреждение в лог, уведомление пропускается |
| `TELEGRAM_CHAT_ID` не задан | Предупреждение в лог, уведомление пропускается |
| localStorage недоступен (приватный режим) | CartUI работает только в памяти, без персистентности |
| Пользователь открывает order-success.html без `?order_id` | Показывается общее сообщение «Заказ оформлен» без номера |

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
Property 18 — fc.record(validOrderBody), проверка pickup_type='self' и status='pending'
Property 19 — fc.array(validOrderBody, { minLength: 2 }), проверка сортировки
Property 20 — fc.record(validOrderBody), проверка вызова mock Telegram API
Property 21 — fc.record(Order), проверка наличия всех полей в formatOrderMessage()
```
