# Дизайн: Управление платежами в админ-панели

## Overview

Расширение страницы `/admin/orders` для управления платежами: отображение статусов, выполнение capture/refund, просмотр истории и ошибок.

---

## Architecture

### Изменения в существующей архитектуре

```
Админ-панель                          Сервер                         ТОЧКА.БАНК
────────────                          ───────                         ───────────
orders.html
  ├─ Таблица заказов ──────────────► GET /api/orders
  ├─ Фильтр по оплате ─────────────► (существующий API)
  │
  ├─ Детали платежа ───────────────► GET /api/payment/operations/:id
  │                                   
  ├─ Capture ───────────────────────► POST /api/payment/operations/:id/capture
  │                                   
  ├─ Refund ────────────────────────► POST /api/payment/operations/:id/refund
  │                                   
  └─ Экспорт CSV ───────────────────► (client-side)
```

### Компоненты

1. **PaymentStatusCell** — ячейка таблицы с отображением статуса оплаты
2. **PaymentDetailsModal** — модальное окно детальной информации
3. **CaptureDialog** — диалог подтверждения списания
4. **RefundDialog** — диалог подтверждения возврата
5. **PaymentHistory** — история операций с платежом
6. **ErrorLog** — отображение ошибок

---

## UI/UX Design

### 1. Изменения в таблице заказов

Добавить колонку "Оплата" после колонки "Сумма":

| Колонка | Описание |
|---------|----------|
| № | Номер заказа |
| Дата | Дата создания |
| Клиент | Имя + телефон |
| Тип | Самовывоз/Доставка |
| Сумма | Сумма заказа |
| **Оплата** | Статус оплаты (NEW) |
| Статус | Статус заказа |
| Действия | Подробнее, Удалить |

**Визуальное отображение статуса оплаты:**

```html
<span class="payment-status payment-status-{status}">
  {иконка} {текст}
</span>
```

Стили:
- `payment-pending` — жёлтый фон `#fef3c7`, тёмно-жёлтый текст
- `payment-completed` — зелёный фон `#d1fae5`, тёмно-зелёный текст
- `payment-failed` — красный фон `#fee2e2`, тёмно-красный текст
- `payment-refunded` — серый фон `#f3f4f6`, серый текст
- `payment-partial_refunded` — оранжевый фон `#ffedd5`, оранжевый текст

### 2. Детальная информация о платеже (модальное окно)

```
┌─────────────────────────────────────────────────┐
│ Заказ #MOLO-2025-0042 — Платёж                 │
├─────────────────────────────────────────────────┤
│                                                 │
│ ИНФОРМАЦИЯ О ПЛАТЕЖЕ                           │
│ ─────────────────────────────────────────────  │
│ ID операции:    pay_abc123def456               │
│ Статус:         ✓ Оплачен                      │
│ Сумма:          1 380 ₽                        │
│ Способ:         СБП                            │
│ Дата создания:  14.05.2026 14:30               │
│ Дата оплаты:    14.05.2026 14:32               │
│                                                 │
│ ДАННЫЕ ПЛАТЕЛЬЩИКА                             │
│ ─────────────────────────────────────────────  │
│ Телефон:        +7 (999) 123-45-67             │
│ Email:          user@example.com               │
│                                                 │
│ ЧЕК                                           │
│ ─────────────────────────────────────────────  │
│ Ссылка:         [Открыть чек]                  │
│                                                 │
│ ИСТОРИЯ ОПЕРАЦИЙ                               │
│ ─────────────────────────────────────────────  │
│ 14:32  Списание    ✓ Успешно    1 380 ₽       │
│ 14:30  Создание    ✓ Успешно    —             │
│                                                 │
│ ДЕЙСТВИЯ                                       │
│ ─────────────────────────────────────────────  │
│ [Вернуть средства]  [Закрыть]                  │
│                                                 │
└─────────────────────────────────────────────────┘
```

### 3. Диалог подтверждения Capture

```
┌─────────────────────────────────────────────────┐
│ Подтверждение списания                         │
├─────────────────────────────────────────────────┤
│                                                 │
│ Заказ: #MOLO-2025-0042                         │
│ Сумма к списанию: 1 380 ₽                      │
│                                                 │
│ ☑ Списать полную сумму                         │
│                                                 │
│ [Отмена]  [Списать 1 380 ₽]                    │
│                                                 │
└─────────────────────────────────────────────────┘
```

### 4. Диалог подтверждения Refund

```
┌─────────────────────────────────────────────────┐
│ Подтверждение возврата                          │
├─────────────────────────────────────────────────┤
│                                                 │
│ Заказ: #MOLO-2025-0042                         │
│ Оплачено: 1 380 ₽                              │
│                                                 │
│ ⚠ Внимание: платежу более 90 дней              │
│                                                 │
│ Сумма возврата:                                 │
│ [__________] ₽  (макс. 1 380 ₽)               │
│                                                 │
│ Причина возврата:                               │
│ [________________________]                      │
│                                                 │
│ [Отмена]  [Вернуть средства]                   │
│                                                 │
└─────────────────────────────────────────────────┘
```

### 5. Новый фильтр

Добавить выпадающий список "Оплата" в панель фильтров:

```html
<select id="filter-payment">
  <option value="">Все платежи</option>
  <option value="pending">Ожидает</option>
  <option value="completed">Оплачен</option>
  <option value="failed">Ошибка</option>
  <option value="refunded">Возвращён</option>
  <option value="partial_refunded">Частичный возврат</option>
</select>
```

---

## Data Models

### Расширенный Order с платежом

```javascript
// GET /api/orders response дополняется полями:
{
  id: 42,
  order_number: "MOLO-2025-0042",
  // ... существующие поля
  
  // Новые поля для платежа
  payment_operation_id: "pay_abc123def456",
  payment_status: "completed", // pending, completed, failed, refunded, partial_refunded
  payment_amount: 1380,        // сумма оплаты
  captured_at: "2025-05-14T14:32:00Z",
  refunded_at: null,
  refund_amount: 0,
  fiscal_receipt_url: "https://check.example.com/123"
}
```

### Payment Details

```javascript
// GET /api/payment/operations/:id response:
{
  paymentOperationId: "pay_abc123def456",
  status: "completed",
  amount: 138000,   // в копейках
  currency: "RUB",
  createdAt: "2025-05-14T14:30:00Z",
  paidAt: "2025-05-14T14:32:00Z",
  paymentMethod: "SBP",
  payerDetails: {
    phone: "+79991234567",
    email: "user@example.com"
  },
  receiptUrl: "https://check.example.com/123",
  history: [
    { timestamp: "2025-05-14T14:32:00Z", action: "capture", status: "success", amount: 138000 },
    { timestamp: "2025-05-14T14:30:00Z", action: "create", status: "success", amount: null }
  ],
  errors: []
}
```

---

## API Endpoints

Используются существующие эндпоинты из `tochka-payment-integration`:

| Метод | Путь | Описание |
|-------|------|----------|
| GET | /api/orders | Список заказов (уже содержит payment_status) |
| GET | /api/payment/operations/:id | Детали платежа |
| POST | /api/payment/operations/:id/capture | Списание средств |
| POST | /api/payment/operations/:id/refund | Возврат средств |

---

## Implementation Plan

### Файл: `public/admin/orders.html`

1. **Добавить CSS стили** для payment-status
2. **Добавить колонку** "Оплата" в таблицу
3. **Добавить фильтр** по payment_status
4. **Добавить модальное окно** деталей платежа
5. **Добавить функции** JavaScript:
   - `renderPaymentStatus(order)` — рендер статуса оплаты
   - `showPaymentDetails(orderId)` — показать детали
   - `capturePayment(orderId, amount)` — выполнить списание
   - `refundPayment(orderId, amount, reason)` — выполнить возврат
   - `applyOrderFilters()` — обновить фильтры

### JavaScript функции

```javascript
// Рендер статуса оплаты в таблице
function renderPaymentStatus(order) {
  const status = order.payment_status || 'pending';
  const amount = order.payment_amount ? (order.payment_amount / 100).toFixed(0) : '';
  
  const statusTexts = {
    pending: 'Ожидает',
    completed: 'Оплачен',
    failed: 'Ошибка',
    refunded: 'Возвращён',
    partial_refunded: 'Частичный возврат'
  };
  
  return `<span class="payment-status payment-status-${status}">
    ${statusTexts[status]} ${amount ? amount + ' ₽' : ''}
  </span>`;
}

// Показать детали платежа
async function showPaymentDetails(orderId) {
  const order = allOrders.find(o => o.id === orderId);
  if (!order || !order.payment_operation_id) {
    showToast('Платёж не найден', true);
    return;
  }
  
  try {
    const details = await api('/api/payment/operations/' + order.payment_operation_id);
    renderPaymentModal(order, details);
  } catch (e) {
    showToast('Ошибка загрузки: ' + e.message, true);
  }
}

// Выполнить capture
async function capturePayment(orderId, amount) {
  try {
    const result = await api('/api/payment/operations/' + orderId + '/capture', {
      method: 'POST',
      body: JSON.stringify({ amount: amount * 100 }) // в копейках
    });
    
    if (result.success) {
      showToast('Списание выполнено');
      loadOrders(); // перезагрузить таблицу
    } else {
      showToast(result.error || 'Ошибка списания', true);
    }
  } catch (e) {
    showToast('Ошибка: ' + e.message, true);
  }
}

// Выполнить refund
async function refundPayment(orderId, amount, reason) {
  try {
    const result = await api('/api/payment/operations/' + orderId + '/refund', {
      method: 'POST',
      body: JSON.stringify({ 
        amount: amount * 100, // в копейках
        reason: reason 
      })
    });
    
    if (result.success) {
      showToast('Возврат выполнен');
      loadOrders();
    } else {
      showToast(result.error || 'Ошибка возврата', true);
    }
  } catch (e) {
    showToast('Ошибка: ' + e.message, true);
  }
}
```

---

## Acceptance Criteria

1. ✅ Таблица заказов показывает статус оплаты с цветовой индикацией
2. ✅ Фильтр "Оплата" работает корректно
3. ✅ Клик на статус открывает детали платежа
4. ✅ Кнопка "Списать" доступна для pending/authorized статусов
5. ✅ Кнопка "Вернуть" доступна для completed статусов
6. ✅ Частичный refund работает корректно
7. ✅ Проверка 90-дневного лимита показывает предупреждение
8. ✅ История операций отображается в деталях
9. ✅ Экспорт CSV включает данные об оплате

---

## Notes

- Используется существующий API из tochka-payment-integration
- Минимальные изменения в server.js не требуются
- Обратная совместимость с существующими заказами (без payment_operation_id)