let allDishes = [];
let allCategories = [];
let activeFilter = '';
let allOrders = [];

// ── Auth ─────────────────────────────────────────────────
// Токен: сначала из sessionStorage (вход через /login.html),
// затем из <meta> (прямой заход с Basic Auth заголовком)
function getToken() {
  const stored = sessionStorage.getItem('admin-token');
  if (stored) return stored;
  const meta = document.querySelector('meta[name="admin-token"]');
  return meta ? meta.content : '';
}

// ── Helpers ──────────────────────────────────────────────
function qs(id) { return document.getElementById(id); }

let toastTimer = null;
function toast(text, isErr = false) {
  const el = qs('toast');
  el.textContent = text;
  el.className = 'toast show' + (isErr ? ' err' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = 'toast'; }, 3000);
}

function fmt(price) {
  const n = Number(price);
  return Number.isFinite(n) ? `${Math.round(n)} ₽` : String(price ?? '');
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Basic ' + getToken(),
      ...(opts.headers || {})
    }
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
  return data;
}

// ── Section switch ────────────────────────────────────────
function switchSection(name) {
  ['dishes', 'categories', 'orders', 'payments'].forEach(s => {
    qs(`section-${s}`).style.display = s === name ? '' : 'none';
  });
  document.querySelectorAll('.sidebar-nav a[data-section]').forEach(a => {
    a.classList.toggle('active', a.dataset.section === name);
  });
  
  // Load orders when switching to orders section
  if (name === 'orders') {
    loadOrders();
  }
}

// ── Category select population ────────────────────────────
function populateCategorySelects() {
  // Form select
  const sel = qs('dish-category');
  const current = sel.value;
  sel.innerHTML = '<option value="" disabled>— выберите категорию —</option>';
  allCategories.forEach(c => {
    const o = document.createElement('option');
    o.value = c.name;
    o.textContent = c.name;
    sel.appendChild(o);
  });
  // Restore selection if still valid
  if (current && allCategories.some(c => c.name === current)) {
    sel.value = current;
  } else {
    sel.value = '';
    sel.selectedIndex = 0;
  }

  // Filter select
  const fsel = qs('filter-category');
  const fcurrent = fsel.value;
  fsel.innerHTML = '<option value="">Все категории</option>';
  allCategories.forEach(c => {
    const o = document.createElement('option');
    o.value = c.name;
    o.textContent = c.name;
    fsel.appendChild(o);
  });
  if (fcurrent) fsel.value = fcurrent;
}

// ── Stats ─────────────────────────────────────────────────
function updateStats() {
  qs('stat-dishes').textContent = allDishes.length;
  qs('stat-cats').textContent = allCategories.length;
  const prices = allDishes.map(d => Number(d.price)).filter(n => n > 0);
  const avg = prices.length ? Math.round(prices.reduce((a, b) => a + b, 0) / prices.length) : 0;
  qs('stat-avg').textContent = avg ? `${avg} ₽` : '—';
}

// ── Dishes table ──────────────────────────────────────────
function renderDishes() {
  const wrap = qs('dishes-wrap');
  const filtered = activeFilter ? allDishes.filter(d => d.category === activeFilter) : allDishes;

  qs('dishes-count').textContent = `(${filtered.length})`;

  if (filtered.length === 0) {
    wrap.innerHTML = '<div class="empty-state"><div class="icon">🍽️</div>Блюд нет. Добавьте первое блюдо выше.</div>';
    return;
  }

  const table = document.createElement('table');
  table.className = 'data-table';
  table.innerHTML = `<thead><tr>
    <th>Категория</th><th>Название</th><th>Цена</th><th>Фото</th><th>Действия</th>
  </tr></thead>`;

  const tbody = document.createElement('tbody');
  filtered.forEach(d => {
    const tr = document.createElement('tr');

    const tdCat = document.createElement('td');
    tdCat.innerHTML = `<span class="cat-pill">${d.category || ''}</span>`;

    const tdName = document.createElement('td');
    tdName.textContent = d.name || '';

    const tdPrice = document.createElement('td');
    tdPrice.className = 'price-cell';
    tdPrice.textContent = fmt(d.price);

    const tdImg = document.createElement('td');
    if (d.image) {
      const img = document.createElement('img');
      img.className = 'thumb';
      img.src = d.image;
      img.alt = '';
      img.onerror = () => { img.style.display = 'none'; };
      tdImg.appendChild(img);
    }

    const tdAct = document.createElement('td');
    tdAct.innerHTML = `<div class="td-actions">
      <button class="btn-edit" data-id="${d.id}">✏️ Изменить</button>
      <button class="btn-danger" data-del="${d.id}">🗑 Удалить</button>
    </div>`;

    tr.append(tdCat, tdName, tdPrice, tdImg, tdAct);
    tbody.appendChild(tr);
  });

  table.appendChild(tbody);
  wrap.innerHTML = '';
  wrap.appendChild(table);

  // Events
  wrap.querySelectorAll('[data-id]').forEach(btn => {
    btn.addEventListener('click', () => {
      const d = allDishes.find(x => x.id === Number(btn.dataset.id));
      if (d) editDish(d);
    });
  });
  wrap.querySelectorAll('[data-del]').forEach(btn => {
    btn.addEventListener('click', () => deleteDish(Number(btn.dataset.del)));
  });
}

// ── Categories list ───────────────────────────────────────
function renderCategories() {
  const wrap = qs('cat-list-wrap');

  if (allCategories.length === 0) {
    wrap.innerHTML = '<div class="empty-state"><div class="icon">📂</div>Категорий пока нет. Добавьте первую.</div>';
    return;
  }

  const list = document.createElement('div');
  list.className = 'cat-list';

  allCategories.forEach(c => {
    const count = allDishes.filter(d => d.category === c.name).length;
    const item = document.createElement('div');
    item.className = 'cat-item';
    item.innerHTML = `
      <div class="cat-item-name">
        <span>📂</span>
        <span>${c.name}</span>
        <span class="cat-count">${count} блюд</span>
      </div>
      <button class="btn-danger" data-cat-del="${c.id}" data-cat-name="${c.name}">Удалить</button>
    `;
    list.appendChild(item);
  });

  wrap.innerHTML = '';
  wrap.appendChild(list);

  wrap.querySelectorAll('[data-cat-del]').forEach(btn => {
    btn.addEventListener('click', () => deleteCategory(Number(btn.dataset.catDel), btn.dataset.catName));
  });
}

// ── Form ──────────────────────────────────────────────────
function resetForm() {
  qs('dish-id').value = '';
  qs('dish-name').value = '';
  qs('dish-description').value = '';
  qs('dish-price').value = '';
  qs('dish-image').value = '';
  qs('dish-category').value = '';
  qs('dish-category').selectedIndex = 0;
  qs('form-title').textContent = 'Добавить блюдо';
  qs('save-btn').textContent = 'Добавить блюдо';
  const preview = qs('dish-image-preview');
  if (preview) preview.style.display = 'none';
}

function editDish(d) {
  qs('dish-id').value = d.id;
  qs('dish-name').value = d.name || '';
  qs('dish-description').value = d.description || '';
  qs('dish-price').value = d.price ?? '';
  qs('dish-image').value = d.image || '';
  qs('form-title').textContent = 'Редактировать блюдо';
  qs('save-btn').textContent = 'Сохранить';
  // Set category after populating
  const sel = qs('dish-category');
  sel.value = d.category || '';
  switchSection('dishes');
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// ── CRUD ──────────────────────────────────────────────────
async function deleteDish(id) {
  const d = allDishes.find(x => x.id === id);
  if (!confirm(`Удалить «${d?.name}»?`)) return;
  try {
    await api(`/api/menu/${id}`, { method: 'DELETE' });
    toast(`«${d?.name}» удалено`);
    await loadAll();
  } catch (e) { toast(e.message, true); }
}

async function deleteCategory(id, name) {
  const count = allDishes.filter(d => d.category === name).length;
  const msg = count > 0
    ? `Удалить категорию «${name}»? В ней ${count} блюд — они останутся в меню без категории.`
    : `Удалить категорию «${name}»?`;
  if (!confirm(msg)) return;
  try {
    await api(`/api/categories/${id}`, { method: 'DELETE' });
    toast(`Категория «${name}» удалена`);
    await loadAll();
  } catch (e) { toast(e.message, true); }
}

// ── Load ──────────────────────────────────────────────────
async function loadAll() {
  try {
    [allCategories, allDishes] = await Promise.all([
      api('/api/categories'),
      api('/api/menu')
    ]);
    populateCategorySelects();
    renderDishes();
    renderCategories();
    updateStats();
  } catch (e) {
    toast(`Ошибка загрузки: ${e.message}`, true);
  }
}

// ── Image upload ──────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  const fileInput = document.getElementById('dish-image-file');
  if (fileInput) {
    fileInput.addEventListener('change', async () => {
      const file = fileInput.files[0];
      if (!file) return;
      const formData = new FormData();
      formData.append('image', file);
      try {
        const res = await fetch('/api/upload', {
          method: 'POST',
          headers: { 'Authorization': 'Basic ' + getToken() },
          body: formData
        });
        const data = await res.json();
        if (res.ok) {
          document.getElementById('dish-image').value = data.url;
          const preview = document.getElementById('dish-image-preview');
          const previewImg = document.getElementById('dish-image-preview-img');
          previewImg.src = data.url;
          preview.style.display = '';
          toast('Фото загружено');
        } else {
          toast(data.error || 'Ошибка загрузки фото', true);
        }
      } catch (e) { toast('Ошибка загрузки фото', true); }
    });
  }
});

// ── Orders ─────────────────────────────────────────────────
const ORDER_STATUSES = {
  pending: 'Новый',
  paid: 'Оплачен',
  failed: 'Ошибка оплаты',
  ready: 'Готов',
  completed: 'Завершён',
  cancelled: 'Отменён'
};

const DELIVERY_TYPES = {
  self: 'Самовывоз',
  courier: 'Доставка'
};

async function loadOrders() {
  try {
    allOrders = await api('/api/orders');
    applyOrderFilters();
  } catch (e) {
    toast(`Ошибка загрузки заказов: ${e.message}`, true);
  }
}

function applyOrderFilters() {
  const statusFilter = qs('filter-status').value;
  const typeFilter = qs('filter-type').value;
  const searchQuery = qs('search-orders').value.toLowerCase();
  
  let filtered = [...allOrders];
  
  if (statusFilter) {
    filtered = filtered.filter(o => o.status === statusFilter);
  }
  
  if (typeFilter) {
    filtered = filtered.filter(o => (o.delivery_type || o.pickup_type) === typeFilter);
  }
  
  if (searchQuery) {
    filtered = filtered.filter(o => {
      const orderNum = (o.order_number || '').toLowerCase();
      const name = (o.customer_name || '').toLowerCase();
      const phone = (o.customer_phone || '').toLowerCase();
      return orderNum.includes(searchQuery) || name.includes(searchQuery) || phone.includes(searchQuery);
    });
  }
  
  renderOrdersTable(filtered);
  updateOrderStats(filtered);
}

function renderOrdersTable(orders) {
  const tbody = qs('orders-tbody');
  
  if (orders.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7" class="empty-state"><div class="icon">📦</div>Заказов не найдено</td></tr>';
    return;
  }
  
  tbody.innerHTML = orders.map(o => {
    const date = o.created_at ? new Date(o.created_at).toLocaleString('ru-RU', {
      day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit'
    }) : '—';
    
    const statusClass = `status-${o.status || 'pending'}`;
    const statusText = ORDER_STATUSES[o.status] || o.status;
    
    const typeText = DELIVERY_TYPES[o.delivery_type || o.pickup_type] || 'Самовывоз';
    const amount = Number(o.total_amount).toFixed(0);
    
    return `<tr>
      <td><strong>${o.order_number || o.id}</strong></td>
      <td>${date}</td>
      <td>
        <div>${o.customer_name || ''}</div>
        <div style="font-size:12px;color:var(--muted);">${o.customer_phone || ''}</div>
      </td>
      <td>${typeText}</td>
      <td class="price-cell">${amount} ₽</td>
      <td><span class="status-pill ${statusClass}">${statusText}</span></td>
      <td>
        <div class="td-actions">
          <button class="btn-edit" onclick="showOrderDetails(${o.id})">Детали</button>
          <button class="btn-ghost" onclick="showStatusChange(${o.id}, '${o.status}')">Изменить</button>
        </div>
      </td>
    </tr>`;
  }).join('');
}

function updateOrderStats(orders) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  
  const todayOrders = orders.filter(o => {
    const orderDate = new Date(o.created_at);
    orderDate.setHours(0, 0, 0, 0);
    return orderDate.getTime() === today.getTime();
  });
  
  const totalRevenue = todayOrders
    .filter(o => o.status === 'paid' || o.status === 'completed')
    .reduce((sum, o) => sum + Number(o.total_amount), 0);
  
  const avgCheck = todayOrders.length > 0
    ? Math.round(todayOrders.reduce((sum, o) => sum + Number(o.total_amount), 0) / todayOrders.length)
    : 0;
  
  qs('stat-orders').textContent = todayOrders.length;
  qs('stat-revenue').textContent = totalRevenue > 0 ? `${totalRevenue.toFixed(0)} ₽` : '—';
  qs('stat-avg-check').textContent = avgCheck > 0 ? `${avgCheck} ₽` : '—';
}

function showOrderDetails(orderId) {
  const order = allOrders.find(o => o.id === orderId);
  if (!order) {
    toast('Заказ не найден', true);
    return;
  }
  
  const modal = qs('order-modal');
  const title = qs('order-modal-title');
  const body = qs('order-modal-body');
  const footer = qs('order-modal-footer');
  
  title.textContent = `Заказ ${order.order_number || '#' + order.id}`;
  
  const items = Array.isArray(order.items) ? order.items : JSON.parse(order.items || '[]');
  const itemsHtml = items.map(item => `
    <div class="order-item">
      <div>
        <span class="order-item-name">${item.name || ''}</span>
        <span class="order-item-qty">× ${item.quantity || 1}</span>
      </div>
      <span class="order-item-price">${((item.price || 0) * (item.quantity || 1)).toFixed(0)} ₽</span>
    </div>
  `).join('');
  
  const statusClass = `status-${order.status || 'pending'}`;
  const statusText = ORDER_STATUSES[order.status] || order.status;
  const typeText = DELIVERY_TYPES[order.delivery_type || order.pickup_type] || 'Самовывоз';
  
  body.innerHTML = `
    <div class="order-detail-row">
      <span class="order-detail-label">Клиент</span>
      <span class="order-detail-value">${order.customer_name || '—'}</span>
    </div>
    <div class="order-detail-row">
      <span class="order-detail-label">Телефон</span>
      <span class="order-detail-value">${order.customer_phone || '—'}</span>
    </div>
    ${order.customer_email ? `
    <div class="order-detail-row">
      <span class="order-detail-label">Email</span>
      <span class="order-detail-value">${order.customer_email}</span>
    </div>` : ''}
    <div class="order-detail-row">
      <span class="order-detail-label">Тип</span>
      <span class="order-detail-value">${typeText}</span>
    </div>
    ${order.delivery_address ? `
    <div class="order-detail-row">
      <span class="order-detail-label">Адрес</span>
      <span class="order-detail-value">${order.delivery_address}</span>
    </div>` : ''}
    ${order.pickup_time ? `
    <div class="order-detail-row">
      <span class="order-detail-label">Время самовывоза</span>
      <span class="order-detail-value">${order.pickup_time}</span>
    </div>` : ''}
    ${order.delivery_time ? `
    <div class="order-detail-row">
      <span class="order-detail-label">Время доставки</span>
      <span class="order-detail-value">${order.delivery_time}</span>
    </div>` : ''}
    <div class="order-detail-row">
      <span class="order-detail-label">Статус оплаты</span>
      <span class="order-detail-value">${order.payment_status || 'pending'}</span>
    </div>
    <div class="order-detail-row">
      <span class="order-detail-label">Статус заказа</span>
      <span class="order-detail-value"><span class="status-pill ${statusClass}">${statusText}</span></span>
    </div>
    <div class="order-detail-row">
      <span class="order-detail-label">Дата создания</span>
      <span class="order-detail-value">${order.created_at ? new Date(order.created_at).toLocaleString('ru-RU') : '—'}</span>
    </div>
    
    <div style="margin-top:16px;font-size:14px;font-weight:800;">Состав заказа</div>
    <div class="order-items-list">
      ${itemsHtml}
    </div>
    
    <div class="order-detail-row" style="margin-top:12px;border-top:2px solid var(--border);padding-top:12px;">
      <span class="order-detail-label">Итого</span>
      <span class="order-detail-value" style="font-size:18px;color:var(--accent);">${Number(order.total_amount).toFixed(0)} ₽</span>
    </div>
  `;
  
  footer.innerHTML = `
    <button class="btn-ghost" onclick="closeOrderModal()">Закрыть</button>
    <button class="btn-primary" onclick="showStatusChange(${order.id}, '${order.status}')">Изменить статус</button>
  `;
  
  modal.classList.add('show');
}

function closeOrderModal() {
  qs('order-modal').classList.remove('show');
}

function showStatusChange(orderId, currentStatus) {
  const order = allOrders.find(o => o.id === orderId);
  if (!order) return;
  
  const modal = qs('order-modal');
  const title = qs('order-modal-title');
  const body = qs('order-modal-body');
  const footer = qs('order-modal-footer');
  
  title.textContent = 'Изменить статус';
  
  const statusOptions = Object.entries(ORDER_STATUSES).map(([value, label]) => {
    const selected = value === currentStatus ? 'selected' : '';
    return `<option value="${value}" ${selected}>${label}</option>`;
  }).join('');
  
  body.innerHTML = `
    <div class="field">
      <label for="new-status">Новый статус</label>
      <select id="new-status" style="width:100%;padding:11px 13px;border-radius:10px;border:1.5px solid var(--border);background:var(--bg);font-size:14px;">
        ${statusOptions}
      </select>
    </div>
  `;
  
  footer.innerHTML = `
    <button class="btn-ghost" onclick="closeOrderModal()">Отмена</button>
    <button class="btn-primary" onclick="updateOrderStatus(${orderId})">Сохранить</button>
  `;
  
  modal.classList.add('show');
}

async function updateOrderStatus(orderId) {
  const newStatus = qs('new-status').value;
  
  try {
    await api(`/api/orders/${orderId}/status`, {
      method: 'PUT',
      body: JSON.stringify({ status: newStatus })
    });
    
    toast(`Статус заказа изменён на «${ORDER_STATUSES[newStatus]}»`);
    closeOrderModal();
    await loadOrders();
    
    // If we have order details modal open, refresh it
    const title = qs('order-modal-title');
    if (title.textContent.includes('Заказ')) {
      showOrderDetails(orderId);
    }
  } catch (e) {
    toast(e.message, true);
  }
}

function exportOrders() {
  const statusFilter = qs('filter-status').value;
  const typeFilter = qs('filter-type').value;
  
  let filtered = [...allOrders];
  
  if (statusFilter) {
    filtered = filtered.filter(o => o.status === statusFilter);
  }
  if (typeFilter) {
    filtered = filtered.filter(o => (o.delivery_type || o.pickup_type) === typeFilter);
  }
  
  const headers = ['№', 'Дата', 'Клиент', 'Телефон', 'Email', 'Тип', 'Адрес', 'Сумма', 'Статус', 'Оплата'];
  const rows = filtered.map(o => [
    o.order_number || o.id,
    o.created_at ? new Date(o.created_at).toLocaleString('ru-RU') : '',
    o.customer_name || '',
    o.customer_phone || '',
    o.customer_email || '',
    DELIVERY_TYPES[o.delivery_type || o.pickup_type] || '',
    o.delivery_address || '',
    o.total_amount,
    ORDER_STATUSES[o.status] || o.status,
    o.payment_status || ''
  ]);
  
  const csvContent = [
    headers.join(';'),
    ...rows.map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(';'))
  ].join('\n');
  
  const blob = new Blob(['\ufeff' + csvContent], { type: 'text/csv;charset=utf-8;' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `orders-${new Date().toISOString().split('T')[0]}.csv`;
  link.click();
}

// ── Payment Registry ──────────────────────────────────────
let currentRegistryData = null;

async function loadPaymentRegistry() {
  const dateFrom = qs('registry-date-from').value;
  const dateTo = qs('registry-date-to').value;
  
  if (!dateFrom || !dateTo) {
    toast('Выберите период', true);
    return;
  }
  
  try {
    const data = await api(`/api/payment/registry?dateFrom=${dateFrom}T00:00:00.000Z&dateTo=${dateTo}T23:59:59.999Z`);
    currentRegistryData = data;
    renderPaymentRegistry(data);
  } catch (e) {
    toast(`Ошибка загрузки реестра: ${e.message}`, true);
  }
}

function renderPaymentRegistry(data) {
  const wrap = qs('registry-table-wrap');
  
  if (!data.registry || data.registry.length === 0) {
    wrap.innerHTML = '<div class="empty-state"><div class="icon">💳</div>Платежей за указанный период не найдено</div>';
    return;
  }
  
  // Update stats
  qs('stat-registry-total').textContent = data.registry.length;
  qs('stat-registry-amount').textContent = data.totals.total > 0 ? `${data.totals.total.toFixed(0)} ₽` : '—';
  qs('stat-registry-net').textContent = data.totals.net > 0 ? `${data.totals.net.toFixed(0)} ₽` : '—';
  
  const table = document.createElement('table');
  table.className = 'data-table';
  table.innerHTML = `<thead><tr>
    <th>ID платежа</th>
    <th>Заказ</th>
    <th>Дата</th>
    <th>Сумма</th>
    <th>Статус</th>
    <th>Возврат</th>
  </tr></thead>`;
  
  const tbody = document.createElement('tbody');
  data.registry.forEach(entry => {
    const tr = document.createElement('tr');
    
    tr.innerHTML = `
      <td style="font-family:monospace;font-size:12px;">${entry.paymentOperationId || '—'}</td>
      <td>${entry.orderId || '—'}</td>
      <td>${entry.date ? new Date(entry.date).toLocaleString('ru-RU') : '—'}</td>
      <td class="price-cell">${entry.amount ? entry.amount.toFixed(2) : '0.00'} ₽</td>
      <td>${entry.status || '—'}</td>
      <td>${entry.refundAmount ? entry.refundAmount.toFixed(2) : '0.00'} ₽</td>
    `;
    tbody.appendChild(tr);
  });
  
  table.appendChild(tbody);
  wrap.innerHTML = '';
  wrap.appendChild(table);
}

function exportRegistryCSV() {
  const dateFrom = qs('registry-date-from').value;
  const dateTo = qs('registry-date-to').value;
  
  if (!dateFrom || !dateTo) {
    toast('Выберите период', true);
    return;
  }
  
  // Use direct download via browser
  const token = getToken();
  const url = `/api/payment/registry/export/csv?dateFrom=${dateFrom}T00:00:00.000Z&dateTo=${dateTo}T23:59:59.999Z`;
  window.open(url, '_blank');
}

function exportRegistryExcel() {
  const dateFrom = qs('registry-date-from').value;
  const dateTo = qs('registry-date-to').value;
  
  if (!dateFrom || !dateTo) {
    toast('Выберите период', true);
    return;
  }
  
  // Use direct download via browser
  const url = `/api/payment/registry/export/excel?dateFrom=${dateFrom}T00:00:00.000Z&dateTo=${dateTo}T23:59:59.999Z`;
  window.open(url, '_blank');
}

// ── Init ──────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  // Если токена нет — на страницу входа
  if (!getToken()) {
    window.location.href = '/login.html';
    return;
  }

  loadAll();
  
  // Set default dates for payment registry (current month)
  const now = new Date();
  const firstDay = new Date(now.getFullYear(), now.getMonth(), 1);
  qs('registry-date-from').value = firstDay.toISOString().split('T')[0];
  qs('registry-date-to').value = now.toISOString().split('T')[0];
  
  // Order filters
  qs('filter-status')?.addEventListener('change', applyOrderFilters);
  qs('filter-type')?.addEventListener('change', applyOrderFilters);
  qs('search-orders')?.addEventListener('input', applyOrderFilters);

  qs('reset-btn').addEventListener('click', resetForm);

  qs('dish-form').addEventListener('submit', async e => {
    e.preventDefault();
    const id = qs('dish-id').value.trim();
    const category = qs('dish-category').value;
    const name = qs('dish-name').value.trim();
    const description = qs('dish-description').value.trim() || null;
    const price = Number(String(qs('dish-price').value).replace(',', '.'));
    const image = qs('dish-image').value.trim() || null;

    if (!category) { toast('Выберите категорию', true); return; }
    if (!name) { toast('Введите название', true); return; }
    if (!price || price <= 0) { toast('Введите корректную цену', true); return; }

    const payload = { category, name, description, price, image };
    try {
      if (id) {
        await api(`/api/menu/${id}`, { method: 'PUT', body: JSON.stringify(payload) });
        toast(`«${name}» обновлено`);
      } else {
        await api('/api/menu', { method: 'POST', body: JSON.stringify(payload) });
        toast(`«${name}» добавлено`);
      }
      resetForm();
      await loadAll();
    } catch (e) { toast(e.message, true); }
  });

  qs('filter-category').addEventListener('change', e => {
    activeFilter = e.target.value;
    const btn = qs('delete-cat-btn');
    btn.style.display = activeFilter ? '' : 'none';
    btn.textContent = activeFilter ? `Удалить все в «${activeFilter}»` : '';
    renderDishes();
  });

  qs('delete-cat-btn').addEventListener('click', async () => {
    if (!activeFilter) return;
    const inCat = allDishes.filter(d => d.category === activeFilter);
    if (!confirm(`Удалить все ${inCat.length} блюд в «${activeFilter}»?`)) return;
    try {
      await Promise.all(inCat.map(d => api(`/api/menu/${d.id}`, { method: 'DELETE' })));
      toast(`Блюда в «${activeFilter}» удалены`);
      activeFilter = '';
      qs('filter-category').value = '';
      qs('delete-cat-btn').style.display = 'none';
      await loadAll();
    } catch (e) { toast(e.message, true); }
  });

  qs('add-cat-btn').addEventListener('click', async () => {
    const input = qs('new-cat-input');
    const name = input.value.trim();
    if (!name) { toast('Введите название категории', true); return; }
    try {
      await api('/api/categories', { method: 'POST', body: JSON.stringify({ name }) });
      toast(`Категория «${name}» добавлена`);
      input.value = '';
      await loadAll();
    } catch (e) { toast(e.message, true); }
  });

  qs('new-cat-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); qs('add-cat-btn').click(); }
  });
});
