# План реализации: Корзина + самовывоз + оплата через СБП

## Обзор

Реализация полного цикла онлайн-заказа с самовывозом: feature flag → корзина в меню → модал корзины → форма оформления → API создания заказа → SBP_Stub → Telegram-уведомление → страница подтверждения.

Стек: Node.js + Express, PostgreSQL (Neon), чистый HTML/CSS/JS без фреймворков.

## Задачи

- [ ] 1. Создать таблицу `orders` и маршруты OrderAPI в `server.js`
  - Добавить `CREATE TABLE IF NOT EXISTS orders` в функцию `initDB()` со всеми полями из дизайна
  - Реализовать `getSbpPaymentUrl(orderId)` — заглушка, возвращает `https://sbp.stub/pay/${orderId}`
  - Реализовать `formatOrderMessage(order)` — формирует HTML-текст для Telegram
  - Реализовать `sendTelegramNotification(order)` — отправляет сообщение через Bot API, при отсутствии токенов пишет warn в лог, ошибки не прерывают ответ клиенту
  - Реализовать `POST /api/orders`: валидация тела, INSERT в БД, вызов SBP_Stub, вызов NotificationService, ответ `{ order_id, payment_url }`
  - Реализовать `GET /api/orders` (adminAuth): SELECT * FROM orders ORDER BY created_at DESC
  - Реализовать `POST /api/payment/webhook`: заглушка, возвращает 200 OK
  - _Требования: 5.1, 5.2, 5.3, 5.5, 6.1, 6.2, 6.3, 6.4, 6.5, 7.1, 7.2, 7.3, 7.4_

  - [ ]* 1.1 Property-тест: SBP_Stub формирует корректный URL
    - **Property 15: SBP_Stub формирует корректный URL**
    - **Validates: Requirements 5.3**
    - `fc.integer({ min: 1 })` → проверить шаблон `https://sbp.stub/pay/{orderId}`

  - [ ]* 1.2 Property-тест: создание заказа возвращает order_id со статусом pending
    - **Property 13: Создание заказа возвращает order_id со статусом pending**
    - **Validates: Requirements 5.1, 6.4**
    - `fc.record(validOrderBody)` → POST /api/orders → проверить `order_id > 0` и `status = 'pending'` в БД

  - [ ]* 1.3 Property-тест: создание заказа возвращает payment_url
    - **Property 14: Создание заказа возвращает payment_url**
    - **Validates: Requirements 5.2**
    - `fc.record(validOrderBody)` → проверить наличие непустого `payment_url` в ответе

  - [ ]* 1.4 Property-тест: инварианты полей нового заказа
    - **Property 18: Инварианты полей нового заказа**
    - **Validates: Requirements 6.3, 6.4**
    - `fc.record(validOrderBody)` → проверить `pickup_type = 'self'` и `status = 'pending'`

  - [ ]* 1.5 Property-тест: состав заказа round-trip через JSONB
    - **Property 17: Состав заказа round-trip через JSONB**
    - **Validates: Requirements 6.2**
    - `fc.array(CartItem)` → POST /api/orders → GET /api/orders → глубокое равенство `items`

  - [ ]* 1.6 Property-тест: список заказов отсортирован по created_at DESC
    - **Property 19: Список заказов отсортирован по created_at DESC**
    - **Validates: Requirements 6.5**
    - `fc.array(validOrderBody, { minLength: 2 })` → создать несколько заказов → проверить порядок

  - [ ]* 1.7 Property-тест: уведомление отправляется для каждого заказа
    - **Property 20: Уведомление отправляется для каждого заказа**
    - **Validates: Requirements 7.1**
    - `fc.record(validOrderBody)` → mock Telegram API → проверить ровно один вызов

  - [ ]* 1.8 Property-тест: сообщение уведомления содержит все обязательные поля
    - **Property 21: Сообщение уведомления содержит все обязательные поля**
    - **Validates: Requirements 7.2**
    - `fc.record(Order)` → проверить наличие `order.id`, `customer_name`, `customer_phone`, позиций и `total_amount` в строке

- [ ] 2. Контрольная точка — убедиться, что все тесты проходят
  - Убедиться, что все тесты проходят, задать вопросы пользователю при необходимости.

- [ ] 3. Создать `public/js/cart.js` — модуль CartUI (feature flag + состояние корзины)
  - Реализовать `window.CartUI` с публичными методами: `init()`, `isEnabled()`, `addItem(dish)`, `getItems()`, `clear()`
  - В `init()`: читать `?preview=1` из URL → записывать в `sessionStorage['molo_preview']`; читать `sessionStorage` для определения флага
  - Реализовать `_loadFromStorage()` / `_saveToStorage()` — работа с `localStorage` под ключом `molo_cart`
  - Если `localStorage` недоступен — работать только в памяти
  - _Требования: 1.1, 1.2, 1.3, 1.4, 2.1, 2.2, 2.3, 2.4_

  - [ ]* 3.1 Property-тест: feature flag управляет видимостью
    - **Property 1: Feature flag управляет видимостью**
    - **Validates: Requirements 1.1, 1.4**
    - `fc.boolean()` для флага → проверить `CartUI.isEnabled()` и отсутствие DOM-элементов корзины

  - [ ]* 3.2 Property-тест: feature flag сохраняется в sessionStorage
    - **Property 2: Feature flag сохраняется в sessionStorage**
    - **Validates: Requirements 1.2, 1.3**
    - `fc.constant('?preview=1')` → вызов `CartUI.init()` → проверить `sessionStorage.getItem('molo_preview') === '1'`

  - [ ]* 3.3 Property-тест: добавление нового блюда устанавливает quantity = 1
    - **Property 3: Добавление нового блюда устанавливает quantity = 1**
    - **Validates: Requirements 2.1**
    - `fc.record({ id, name, price })` → `CartUI.addItem(dish)` → проверить `quantity === 1`

  - [ ]* 3.4 Property-тест: повторное добавление увеличивает quantity на 1
    - **Property 4: Повторное добавление увеличивает quantity на 1**
    - **Validates: Requirements 2.2**
    - `fc.record + fc.integer({ min: 1 })` → добавить N раз → проверить `quantity === N + 1`

  - [ ]* 3.5 Property-тест: корзина round-trip через localStorage
    - **Property 5: Корзина round-trip через localStorage**
    - **Validates: Requirements 2.3, 2.4**
    - `fc.array(CartItem)` → сохранить → `_loadFromStorage()` → глубокое равенство

- [ ] 4. Реализовать отображение корзины: счётчик в хедере и модал
  - Добавить HTML-разметку иконки корзины со счётчиком в хедер `menu.html` (скрыта по умолчанию)
  - Добавить HTML-разметку модала корзины в `menu.html`
  - Реализовать `_renderCounter()` — обновление числа на иконке; при пустой корзине — скрывать или показывать «0»
  - Реализовать `_renderModal()` — список позиций с названием, ценой за единицу, количеством, суммой по позиции; кнопки «+», «−», «удалить»; итоговая сумма; сообщение «Корзина пуста» при пустой корзине; кнопка «Оформить заказ» (скрыта при пустой корзине)
  - Реализовать `_openModal()` / `_closeModal()` — управление видимостью модала
  - Добавить стили для иконки корзины, счётчика, модала и его содержимого в `style.css`
  - _Требования: 2.5, 2.6, 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7_

  - [ ]* 4.1 Property-тест: счётчик корзины равен сумме количеств
    - **Property 6: Счётчик корзины равен сумме количеств**
    - **Validates: Requirements 2.5, 2.6**
    - `fc.array(CartItem)` → проверить `counter === items.reduce((s, i) => s + i.quantity, 0)`

  - [ ]* 4.2 Property-тест: рендер позиции содержит все обязательные поля
    - **Property 7: Рендер позиции содержит все обязательные поля**
    - **Validates: Requirements 3.2**
    - `fc.record(CartItem)` → проверить наличие названия, цены, количества и суммы по позиции в HTML

  - [ ]* 4.3 Property-тест: итоговая сумма корзины равна сумме произведений
    - **Property 8: Итоговая сумма корзины равна сумме произведений**
    - **Validates: Requirements 3.3**
    - `fc.array(CartItem)` → проверить `total === items.reduce((s, i) => s + i.price * i.quantity, 0)`

  - [ ]* 4.4 Property-тест: уменьшение quantity до 0 удаляет позицию
    - **Property 9: Уменьшение quantity до 0 удаляет позицию**
    - **Validates: Requirements 3.5, 3.6**
    - `fc.record(CartItem, { quantity: 1 })` → декремент → проверить отсутствие в `CartUI.getItems()`

- [ ] 5. Добавить кнопку «В корзину» в карточки блюд (`menu.js`)
  - В `renderDishes()` после создания `.body` добавить кнопку `btn-add-to-cart`, если `window.CartUI?.isEnabled()` возвращает `true`
  - Обработчик кнопки: `e.stopPropagation()` + `CartUI.addItem({ id, name, price })`
  - Подключить `cart.js` в `menu.html` **до** `menu.js`
  - Добавить стили для `.btn-add-to-cart` в `style.css`
  - _Требования: 1.1, 1.2, 2.1, 2.2_

- [ ] 6. Реализовать форму оформления заказа и валидацию
  - Реализовать `_openOrderForm()` — переключение модала в режим формы с полями: имя (required), телефон (required), email (optional); тип получения «Самовывоз» (только для чтения)
  - Реализовать `validatePhone(phone)` — длина 10–15 символов, только `[0-9 \-\(\)\+]`
  - Реализовать `validateEmail(email)` — наличие `@` и домена после него
  - Показывать ошибки валидации inline рядом с полем (не через `alert()`)
  - _Требования: 4.1, 4.2, 4.3, 4.4, 4.5_

  - [ ]* 6.1 Property-тест: валидация обязательных полей формы
    - **Property 10: Валидация обязательных полей формы**
    - **Validates: Requirements 4.3**
    - `fc.record({ name: fc.string(), phone: fc.string() })` с пустыми значениями → проверить `false` и отсутствие отправки

  - [ ]* 6.2 Property-тест: валидация формата телефона
    - **Property 11: Валидация формата телефона**
    - **Validates: Requirements 4.4**
    - `fc.string()` → проверить `validatePhone()` против regex `[0-9 \-\(\)\+]` длиной 10–15

  - [ ]* 6.3 Property-тест: валидация формата email
    - **Property 12: Валидация формата email**
    - **Validates: Requirements 4.5**
    - `fc.string()` → проверить `validateEmail()` возвращает `false` без `@` или домена

- [ ] 7. Реализовать отправку заказа и редирект
  - Реализовать `_submitOrder()` — сборка тела запроса из формы и `CartUI.getItems()`, POST /api/orders, обработка ответа
  - При успехе: `CartUI.clear()` → редирект на `order-success.html?order_id={id}`
  - При ошибке сервера: показать сообщение об ошибке в форме
  - _Требования: 5.1, 5.2, 5.4, 5.5, 5.6_

  - [ ]* 7.1 Property-тест: корзина очищается после успешного заказа
    - **Property 16: Корзина очищается после успешного заказа**
    - **Validates: Requirements 5.6**
    - `fc.array(CartItem, { minLength: 1 })` → mock успешного POST → проверить `CartUI.getItems() === []` и `localStorage`

- [ ] 8. Создать страницу `public/order-success.html`
  - Статическая страница с шапкой сайта и подключённым `style.css`
  - Читать `order_id` из query string (`?order_id=42`) через `URLSearchParams`
  - Если `order_id` есть — показать «Заказ №{id} оформлен»; если нет — «Заказ оформлен»
  - _Требования: 5.4_

- [ ] 9. Контрольная точка — убедиться, что все тесты проходят
  - Убедиться, что все тесты проходят, задать вопросы пользователю при необходимости.

## Примечания

- Задачи, помеченные `*`, являются необязательными и могут быть пропущены для ускорения MVP
- Каждая задача ссылается на конкретные требования для трассируемости
- Property-тесты используют [fast-check](https://github.com/dubzzz/fast-check), unit-тесты — [Vitest](https://vitest.dev/)
- Каждый property-тест помечается комментарием: `// Feature: cart-and-pickup-payment, Property N: <текст>`
- `cart.js` подключается в `menu.html` **до** `menu.js`
