/**
 * CartUI — модуль корзины для Molo Bistro
 * Feature flag: ?preview=1 / sessionStorage['molo_preview']
 * Хранение: localStorage['molo_cart'] (JSON-массив CartItem)
 */
(function () {
  'use strict';

  // ── Внутреннее состояние ──────────────────────────────────────────────────
  let _items = []; // CartItem[]
  let _storageAvailable = false;
  
  // Состояние согласий
  let _agreements = {
    offer_accepted: false,
    pdpa_consent: false
  };

  function _checkStorage() {
    try {
      localStorage.setItem('__test__', '1');
      localStorage.removeItem('__test__');
      _storageAvailable = true;
    } catch (e) {
      _storageAvailable = false;
    }
  }

  function _loadFromStorage() {
    if (!_storageAvailable) return;
    try {
      const raw = localStorage.getItem('molo_cart');
      _items = raw ? JSON.parse(raw) : [];
    } catch (e) {
      _items = [];
    }
  }

  function _saveToStorage() {
    if (!_storageAvailable) return;
    try {
      localStorage.setItem('molo_cart', JSON.stringify(_items));
    } catch (e) {
      // ignore
    }
  }

  // ── Согласия (оферта и ПДн) ───────────────────────────────────────────────

  /**
   * Валидация согласий перед отправкой
   * Validates: Requirements 1.4, 2.4, 3.1, 3.2, 3.3, 3.4
   */
  function _validateAgreements() {
    const offerCheckbox = document.getElementById('order-offer-accepted');
    const pdpaCheckbox = document.getElementById('order-pdpa-consent');
    
    const offerError = document.getElementById('order-offer-error');
    const pdpaError = document.getElementById('order-pdpa-error');
    
    let valid = true;
    
    // Сброс ошибок
    if (offerError) { offerError.textContent = ''; offerError.style.display = 'none'; }
    if (pdpaError) { pdpaError.textContent = ''; pdpaError.style.display = 'none'; }
    
    // Проверка оферты
    if (!offerCheckbox || !offerCheckbox.checked) {
      if (offerError) {
        offerError.textContent = 'Необходимо согласиться с офертой';
        offerError.style.display = 'block';
      }
      valid = false;
    }
    
    // Проверка согласия на ПДн
    if (!pdpaCheckbox || !pdpaCheckbox.checked) {
      if (pdpaError) {
        pdpaError.textContent = 'Необходимо согласиться на обработку персональных данных';
        pdpaError.style.display = 'block';
      }
      valid = false;
    }
    
    return valid;
  }

  /**
   * Сохранение согласий в localStorage
   * Validates: Requirements 4.1, 4.2
   */
  function _saveAgreements() {
    const offerCheckbox = document.getElementById('order-offer-accepted');
    const pdpaCheckbox = document.getElementById('order-pdpa-consent');
    
    if (offerCheckbox) _agreements.offer_accepted = offerCheckbox.checked;
    if (pdpaCheckbox) _agreements.pdpa_consent = pdpaCheckbox.checked;
    
    try {
      localStorage.setItem('molo_cart_agreements', JSON.stringify(_agreements));
    } catch (e) {
      // ignore
    }
  }

  /**
   * Загрузка согласий из localStorage
   * Validates: Requirements 4.1, 4.2
   */
  function _loadAgreements() {
    try {
      const raw = localStorage.getItem('molo_cart_agreements');
      if (raw) {
        _agreements = JSON.parse(raw);
      }
    } catch (e) {
      _agreements = { offer_accepted: false, pdpa_consent: false };
    }
  }

  /**
   * Восстановление чекбоксов при открытии формы
   * Validates: Requirements 4.2
   */
  function _restoreAgreements() {
    const offerCheckbox = document.getElementById('order-offer-accepted');
    const pdpaCheckbox = document.getElementById('order-pdpa-consent');
    
    if (offerCheckbox) offerCheckbox.checked = _agreements.offer_accepted;
    if (pdpaCheckbox) pdpaCheckbox.checked = _agreements.pdpa_consent;
  }

  /**
   * Сброс согласий
   * Validates: Requirements 4.3
   */
  function _resetAgreements() {
    _agreements = { offer_accepted: false, pdpa_consent: false };
    try {
      localStorage.removeItem('molo_cart_agreements');
    } catch (e) {
      // ignore
    }
  }

  /**
   * Настройка обработчиков событий для чекбоксов согласий
   */
  function _setupAgreementListeners() {
    const offerCheckbox = document.getElementById('order-offer-accepted');
    const pdpaCheckbox = document.getElementById('order-pdpa-consent');
    
    if (offerCheckbox) {
      offerCheckbox.addEventListener('change', _saveAgreements);
    }
    if (pdpaCheckbox) {
      pdpaCheckbox.addEventListener('change', _saveAgreements);
    }
  }

  // ── Валидация ─────────────────────────────────────────────────────────────

  /**
   * Validates: Requirements 4.4
   * Длина 10–15, только [0-9 \-\(\)\+]
   */
  function validatePhone(phone) {
    if (typeof phone !== 'string') return false;
    const trimmed = phone.trim();
    if (trimmed.length < 10 || trimmed.length > 15) return false;
    return /^[0-9 \-\(\)\+]+$/.test(trimmed);
  }

  /**
   * Validates: Requirements 4.5
   * Наличие @ и домена после него
   */
  function validateEmail(email) {
    if (typeof email !== 'string' || email.trim() === '') return false;
    const at = email.indexOf('@');
    if (at < 1) return false;
    const domain = email.slice(at + 1);
    return domain.includes('.') && domain.length > 2;
  }

  // ── Рендер счётчика ───────────────────────────────────────────────────────

  function _renderCounter() {
    const badge = document.getElementById('cart-badge');
    if (!badge) return;
    const total = _items.reduce((s, i) => s + i.quantity, 0);
    badge.textContent = total;
    badge.style.display = total > 0 ? 'flex' : 'none';
  }

  // ── Рендер модала ─────────────────────────────────────────────────────────

  function _renderModal() {
    const list = document.getElementById('cart-items-list');
    const totalEl = document.getElementById('cart-total-amount');
    const emptyMsg = document.getElementById('cart-empty-msg');
    const checkoutBtn = document.getElementById('cart-checkout-btn');
    if (!list) return;

    list.innerHTML = '';

    if (_items.length === 0) {
      if (emptyMsg) emptyMsg.style.display = 'block';
      if (checkoutBtn) checkoutBtn.style.display = 'none';
      if (totalEl) totalEl.textContent = '0 ₽';
      return;
    }

    if (emptyMsg) emptyMsg.style.display = 'none';
    if (checkoutBtn) checkoutBtn.style.display = 'block';

    _items.forEach((item) => {
      const row = document.createElement('div');
      row.className = 'cart-item';
      row.dataset.id = item.id;

      const info = document.createElement('div');
      info.className = 'cart-item-info';

      const name = document.createElement('div');
      name.className = 'cart-item-name';
      name.textContent = item.name;

      const unitPrice = document.createElement('div');
      unitPrice.className = 'cart-item-unit-price';
      unitPrice.textContent = `${Math.round(item.price)} ₽ × `;

      info.appendChild(name);
      info.appendChild(unitPrice);

      const controls = document.createElement('div');
      controls.className = 'cart-item-controls';

      const btnMinus = document.createElement('button');
      btnMinus.className = 'cart-qty-btn';
      btnMinus.textContent = '−';
      btnMinus.setAttribute('aria-label', 'Уменьшить количество');
      btnMinus.addEventListener('click', () => _changeQty(item.id, -1));

      const qty = document.createElement('span');
      qty.className = 'cart-item-qty';
      qty.textContent = item.quantity;

      const btnPlus = document.createElement('button');
      btnPlus.className = 'cart-qty-btn';
      btnPlus.textContent = '+';
      btnPlus.setAttribute('aria-label', 'Увеличить количество');
      btnPlus.addEventListener('click', () => _changeQty(item.id, 1));

      const itemTotal = document.createElement('span');
      itemTotal.className = 'cart-item-total';
      itemTotal.textContent = `${Math.round(item.price * item.quantity)} ₽`;

      controls.appendChild(btnMinus);
      controls.appendChild(qty);
      controls.appendChild(btnPlus);
      controls.appendChild(itemTotal);

      row.appendChild(info);
      row.appendChild(controls);
      list.appendChild(row);
    });

    const total = _items.reduce((s, i) => s + i.price * i.quantity, 0);
    if (totalEl) totalEl.textContent = `${Math.round(total)} ₽`;
  }

  function _changeQty(id, delta) {
    const idx = _items.findIndex((i) => i.id === id);
    if (idx === -1) return;
    _items[idx].quantity += delta;
    if (_items[idx].quantity <= 0) {
      _items.splice(idx, 1);
    }
    _saveToStorage();
    _renderCounter();
    _renderModal();
  }

  // ── Открытие / закрытие модала ────────────────────────────────────────────

  function _openModal() {
    const overlay = document.getElementById('cart-modal-overlay');
    if (!overlay) return;
    _showCartView();
    _renderModal();
    overlay.classList.add('open');
    document.body.style.overflow = 'hidden';
  }

  function _closeModal() {
    const overlay = document.getElementById('cart-modal-overlay');
    if (!overlay) return;
    overlay.classList.remove('open');
    document.body.style.overflow = '';
  }

  // ── Переключение между видом корзины и формой ─────────────────────────────

  function _showCartView() {
    const cartView = document.getElementById('cart-view');
    const formView = document.getElementById('cart-form-view');
    if (cartView) cartView.style.display = 'block';
    if (formView) formView.style.display = 'none';
  }

  function _openOrderForm() {
    const cartView = document.getElementById('cart-view');
    const formView = document.getElementById('cart-form-view');
    if (cartView) cartView.style.display = 'none';
    if (formView) {
      formView.style.display = 'block';
      // Сбросить ошибки
      formView.querySelectorAll('.field-error').forEach((el) => {
        el.textContent = '';
        el.style.display = 'none';
      });
      const errMsg = document.getElementById('order-form-error');
      if (errMsg) { errMsg.textContent = ''; errMsg.style.display = 'none'; }
      
      // Восстановить состояние чекбоксов согласий
      _restoreAgreements();
      // Настроить обработчики событий для чекбоксов
      _setupAgreementListeners();
    }
  }

  // ── Отправка заказа ───────────────────────────────────────────────────────

  async function _submitOrder() {
    const nameEl = document.getElementById('order-name');
    const phoneEl = document.getElementById('order-phone');
    const emailEl = document.getElementById('order-email');
    const addressEl = document.getElementById('order-address');
    const addressErr = document.getElementById('order-address-error');
    const errMsg = document.getElementById('order-form-error');

    const nameErr = document.getElementById('order-name-error');
    const phoneErr = document.getElementById('order-phone-error');
    const emailErr = document.getElementById('order-email-error');

    let valid = true;

    // Сбросить ошибки
    [nameErr, phoneErr, emailErr, addressErr].forEach((el) => {
      if (el) { el.textContent = ''; el.style.display = 'none'; }
    });
    if (errMsg) { errMsg.textContent = ''; errMsg.style.display = 'none'; }

    const name = nameEl ? nameEl.value.trim() : '';
    const phone = phoneEl ? phoneEl.value.trim() : '';
    const email = emailEl ? emailEl.value.trim() : '';

    // Получить способ получения
    const deliveryTypeEl = document.querySelector('input[name="delivery_type"]:checked');
    const delivery_type = deliveryTypeEl ? deliveryTypeEl.value : 'self';
    
    // Получить способ оплаты
    const paymentMethodEl = document.querySelector('input[name="payment_method"]:checked');
    const payment_method = paymentMethodEl ? paymentMethodEl.value : 'cash';

    // Для доставки обязателен адрес
    let address = '';
    if (delivery_type === 'courier') {
      address = addressEl ? addressEl.value.trim() : '';
      if (!address) {
        if (addressErr) { addressErr.textContent = 'Введите адрес доставки'; addressErr.style.display = 'block'; }
        valid = false;
      }
    }

    if (!name) {
      if (nameErr) { nameErr.textContent = 'Введите имя'; nameErr.style.display = 'block'; }
      valid = false;
    }

    // Валидация согласий (оферта и ПДн)
    if (!_validateAgreements()) {
      valid = false;
    }

    if (!phone) {
      if (phoneErr) { phoneErr.textContent = 'Введите телефон'; phoneErr.style.display = 'block'; }
      valid = false;
    } else if (!validatePhone(phone)) {
      if (phoneErr) { phoneErr.textContent = 'Неверный формат телефона (10–15 цифр, +, -, скобки)'; phoneErr.style.display = 'block'; }
      valid = false;
    }

    if (email && !validateEmail(email)) {
      if (emailErr) { emailErr.textContent = 'Неверный формат email'; emailErr.style.display = 'block'; }
      valid = false;
    }

    if (!valid) return;

    const items = _items.map((i) => ({
      dish_id: i.id,
      name: i.name,
      price: i.price,
      quantity: i.quantity,
    }));
    const subtotal = _items.reduce((s, i) => s + i.price * i.quantity, 0);

    // Рассчитать стоимость доставки
    const delivery_cost = delivery_type === 'courier' ? CartUI.calculateDelivery(subtotal) : 0;
    const total_amount = subtotal + delivery_cost;

    const body = {
      customer_name: name,
      customer_phone: phone,
      delivery_type,
      payment_method,
      items,
      total_amount,
      delivery_cost,
      offer_accepted: _agreements.offer_accepted,
      pdpa_consent: _agreements.pdpa_consent,
    };
    if (email) body.customer_email = email;

    // Поля для самовывоза
    if (delivery_type === 'self') {
      const pickupTimeEl = document.getElementById('order-pickup-time');
      if (pickupTimeEl && pickupTimeEl.value.trim()) {
        body.pickup_time = pickupTimeEl.value.trim();
      }
    }

    // Поля для доставки
    if (delivery_type === 'courier') {
      body.delivery_address = address;
      const deliveryTimeEl = document.getElementById('order-delivery-time');
      if (deliveryTimeEl && deliveryTimeEl.value.trim()) {
        body.delivery_time = deliveryTimeEl.value.trim();
      }
      const commentEl = document.getElementById('order-comment');
      if (commentEl && commentEl.value.trim()) {
        body.delivery_comment = commentEl.value.trim();
      }
    }

    // Количество приборов
    const tablewareEl = document.getElementById('order-tableware');
    if (tablewareEl) {
      const tableware = parseInt(tablewareEl.value, 10);
      if (!isNaN(tableware) && tableware > 0) {
        body.tableware_count = tableware;
      }
    }

    const submitBtn = document.getElementById('order-submit-btn');
    if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'Отправка…'; }

    try {
      // Add timeout to prevent hanging
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 15000);
      
      const res = await fetch('/api/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal
      });
      clearTimeout(timeoutId);

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `Ошибка сервера (${res.status})`);
      }

      const data = await res.json();
      window.CartUI.clear();
      
      // Handle payment redirect if payment_url is provided (Tochka integration)
      if (data.payment_url) {
        // Redirect to Tochka payment page
        window.location.href = data.payment_url;
      } else {
        // No online payment - go to success page
        window.location.href = `/order-success.html?order_id=${data.order_id}`;
      }
    } catch (e) {
      if (errMsg) {
        errMsg.textContent = e.message || 'Не удалось оформить заказ. Попробуйте ещё раз.';
        errMsg.style.display = 'block';
      }
      if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = 'Оформить заказ'; }
    }
  }

  // ── Настройки доставки ────────────────────────────────────────────────────

  let _deliverySettings = null;

  async function _loadDeliverySettings() {
    try {
      const res = await fetch('/api/settings/delivery');
      if (res.ok) {
        _deliverySettings = await res.json();
      }
    } catch (e) {
      // Используем значения по умолчанию
      _deliverySettings = {
        free_delivery_threshold: 2000,
        delivery_cost: 200,
        work_hours: '10:00 - 22:00'
      };
    }
  }

  // ── Переключение Самовывоз/Доставка ─────────────────────────────────────

  function _setupDeliveryToggle() {
    const pickupFields = document.getElementById('cart-pickup-fields');
    const deliveryFields = document.getElementById('cart-delivery-fields');
    const deliveryInfo = document.getElementById('cart-delivery-info');
    const deliveryCostEl = document.getElementById('cart-delivery-cost');

    const selfRadio = document.querySelector('input[name="delivery_type"][value="self"]');
    const courierRadio = document.querySelector('input[name="delivery_type"][value="courier"]');

    if (!selfRadio || !courierRadio) return;

    function updateDeliveryForm() {
      const isCourier = courierRadio.checked;

      if (pickupFields) pickupFields.style.display = isCourier ? 'none' : 'block';
      if (deliveryFields) deliveryFields.style.display = isCourier ? 'block' : 'none';
      if (deliveryInfo) deliveryInfo.style.display = isCourier ? 'flex' : 'none';

      // Рассчитать стоимость доставки
      if (isCourier && deliveryCostEl) {
        const subtotal = _items.reduce((s, i) => s + i.price * i.quantity, 0);
        const deliveryCost = CartUI.calculateDelivery(subtotal);
        deliveryCostEl.textContent = deliveryCost === 0 ? 'Бесплатно' : `${deliveryCost} ₽`;
      }
    }

    selfRadio.addEventListener('change', updateDeliveryForm);
    courierRadio.addEventListener('change', updateDeliveryForm);

    // Initial update
    updateDeliveryForm();
  }

  // ── Публичный API ─────────────────────────────────────────────────────────

  window.CartUI = {
    init() {
      _checkStorage();

      // Feature flag: ?preview=1 → sessionStorage
      const params = new URLSearchParams(window.location.search);
      if (params.get('preview') === '1') {
        try { sessionStorage.setItem('molo_preview', '1'); } catch (e) { /* ignore */ }
      }

      _loadFromStorage();
      _loadAgreements();

      // Показать иконку корзины только если флаг активен
      const iconWrap = document.getElementById('cart-icon-wrap');
      if (iconWrap) {
        iconWrap.style.display = this.isEnabled() ? 'flex' : 'none';
      }

      if (!this.isEnabled()) return;

      _loadDeliverySettings();
      _renderCounter();
      _setupDeliveryToggle();

      // Обработчики иконки корзины
      const cartIcon = document.getElementById('cart-icon-btn');
      if (cartIcon) {
        cartIcon.addEventListener('click', _openModal);
      }

      // Закрытие модала
      const overlay = document.getElementById('cart-modal-overlay');
      if (overlay) {
        overlay.addEventListener('click', (e) => {
          if (e.target === overlay) _closeModal();
        });
      }

      const closeBtn = document.getElementById('cart-modal-close');
      if (closeBtn) closeBtn.addEventListener('click', _closeModal);

      // Кнопка «Оформить заказ»
      const checkoutBtn = document.getElementById('cart-checkout-btn');
      if (checkoutBtn) checkoutBtn.addEventListener('click', _openOrderForm);

      // Кнопка «Назад» в форме
      const backBtn = document.getElementById('order-form-back');
      if (backBtn) backBtn.addEventListener('click', () => { _showCartView(); _renderModal(); });

      // Отправка формы
      const submitBtn = document.getElementById('order-submit-btn');
      if (submitBtn) submitBtn.addEventListener('click', _submitOrder);

      // Закрытие по Escape
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') _closeModal();
      });
    },

    isEnabled() {
      try {
        return sessionStorage.getItem('molo_preview') === '1';
      } catch (e) {
        return false;
      }
    },

    addItem(dish) {
      const existing = _items.find((i) => i.id === dish.id);
      if (existing) {
        existing.quantity += 1;
      } else {
        _items.push({ id: dish.id, name: dish.name, price: dish.price, quantity: 1 });
      }
      _saveToStorage();
      _renderCounter();
    },

    getItems() {
      return _items.slice();
    },

    clear() {
      _items = [];
      _saveToStorage();
      _renderCounter();
      // Сбросить согласия при очистке корзины
      _resetAgreements();
    },

    // Экспортируем для тестов
    validatePhone,
    validateEmail,
    _loadFromStorage,
    _saveToStorage,
    _renderCounter,
    _renderModal,
    _changeQty,

    /**
     * Рассчитать стоимость доставки на основе суммы заказа
     * @param {number} subtotal - сумма заказа без доставки
     * @returns {number} - стоимость доставки (0 если бесплатно)
     */
    calculateDelivery(subtotal) {
      if (!_deliverySettings) return 200; // Значение по умолчанию
      if (subtotal >= _deliverySettings.free_delivery_threshold) {
        return 0;
      }
      return _deliverySettings.delivery_cost;
    },

    /**
     * Получить настройки доставки
     * @returns {Promise<Object>} - настройки доставки
     */
    getDeliverySettings() {
      return _loadDeliverySettings().then(() => _deliverySettings || {
        free_delivery_threshold: 2000,
        delivery_cost: 200,
        work_hours: '10:00 - 22:00'
      });
    },
  };
})();
