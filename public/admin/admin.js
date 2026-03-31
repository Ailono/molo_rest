let allDishes = [];
let allCategories = [];
let activeFilter = '';

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
  ['dishes', 'categories'].forEach(s => {
    qs(`section-${s}`).style.display = s === name ? '' : 'none';
  });
  document.querySelectorAll('.sidebar-nav a[data-section]').forEach(a => {
    a.classList.toggle('active', a.dataset.section === name);
  });
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
  qs('dish-price').value = '';
  qs('dish-image').value = '';
  qs('dish-category').value = '';
  qs('dish-category').selectedIndex = 0;
  qs('form-title').textContent = 'Добавить блюдо';
  qs('save-btn').textContent = 'Добавить блюдо';
}

function editDish(d) {
  qs('dish-id').value = d.id;
  qs('dish-name').value = d.name || '';
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

// ── Init ──────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  // Если токена нет — на страницу входа
  if (!getToken()) {
    window.location.href = '/login.html';
    return;
  }

  loadAll();

  qs('reset-btn').addEventListener('click', resetForm);

  qs('dish-form').addEventListener('submit', async e => {
    e.preventDefault();
    const id = qs('dish-id').value.trim();
    const category = qs('dish-category').value;
    const name = qs('dish-name').value.trim();
    const price = Number(String(qs('dish-price').value).replace(',', '.'));
    const image = qs('dish-image').value.trim() || null;

    if (!category) { toast('Выберите категорию', true); return; }
    if (!name) { toast('Введите название', true); return; }
    if (!price || price <= 0) { toast('Введите корректную цену', true); return; }

    const payload = { category, name, price, image };
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
