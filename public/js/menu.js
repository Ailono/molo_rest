async function fetchMenu() {
  const res = await fetch('/api/menu', { cache: 'no-store' });
  if (!res.ok) throw new Error('Не удалось загрузить меню');
  return await res.json();
}

async function fetchCategories() {
  const res = await fetch('/api/categories', { cache: 'no-store' });
  if (!res.ok) return [];
  return await res.json();
}

function formatPrice(price) {
  const n = Number(price);
  if (!Number.isFinite(n)) return String(price ?? '');
  return `${Math.round(n)} ₽`;
}

function renderDishes(dishes) {
  const grid = document.getElementById('menu-grid');
  if (!grid) return;
  grid.innerHTML = '';

  if (!dishes || dishes.length === 0) {
    grid.innerHTML = '<div class="empty">В этой категории пока нет позиций.</div>';
    return;
  }

  dishes.forEach((d) => {
    const card = document.createElement('article');
    card.className = 'card';
    card.addEventListener('click', () => openModal(d));

    const media = document.createElement('div');
    media.className = 'media';

    if (d.image) {
      const img = document.createElement('img');
      img.loading = 'lazy';
      img.alt = d.name || '';
      img.src = d.image;
      img.addEventListener('error', () => { img.parentNode && (img.parentNode.innerHTML = ''); });
      media.appendChild(img);
    }

    const body = document.createElement('div');
    body.className = 'body';

    const dishInfo = document.createElement('div');
    dishInfo.className = 'dish-info';

    const name = document.createElement('div');
    name.className = 'dish-name';
    name.textContent = d.name || '';

    const price = document.createElement('div');
    price.className = 'dish-price';
    price.textContent = `${Math.round(Number(d.price))} ₽`;

    dishInfo.appendChild(name);
    dishInfo.appendChild(price);
    body.appendChild(dishInfo);

    if (window.CartUI?.isEnabled()) {
      const btn = document.createElement('button');
      btn.className = 'btn-add-to-cart';
      btn.textContent = 'В корзину';
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        window.CartUI.addItem({ id: d.id, name: d.name, price: d.price });
      });
      body.appendChild(btn);
    }

    card.appendChild(media);
    card.appendChild(body);
    grid.appendChild(card);
  });
}

function openModal(d) {
  const overlay = document.getElementById('dish-modal-overlay');
  document.getElementById('modal-name').textContent = d.name || '';
  document.getElementById('modal-price').textContent = `${Math.round(Number(d.price))} ₽`;
  document.getElementById('modal-desc').textContent = d.description || '';
  document.getElementById('modal-desc').style.display = d.description ? '' : 'none';

  const img = document.getElementById('modal-img');
  const placeholder = document.getElementById('modal-img-placeholder');
  if (d.image) {
    img.src = d.image;
    img.style.display = 'block';
    placeholder.style.display = 'none';
  } else {
    img.style.display = 'none';
    placeholder.style.display = 'block';
  }

  overlay.classList.add('open');
  document.body.style.overflow = 'hidden';
}

document.addEventListener('DOMContentLoaded', async () => {
  let all = [];
  let categories = [];
  let active = '';

  const tabsRoot = document.getElementById('category-tabs');
  const grid = document.getElementById('menu-grid');

  const rerender = () => {
    const filtered = active ? all.filter(x => x.category === active) : [];
    renderDishes(filtered);
    document.querySelectorAll('.tab').forEach(t => {
      t.classList.toggle('active', t.dataset.cat === active);
    });
  };

  const buildTabs = () => {
    if (!tabsRoot) return;
    tabsRoot.innerHTML = '';

    // Только категории у которых есть блюда, в порядке из БД
    const catNames = categories.map(c => c.name);
    const inDishes = new Set(all.map(d => d.category));
    const ordered = catNames.filter(n => inDishes.has(n));

    if (ordered.length === 0) {
      tabsRoot.style.display = 'none';
      if (grid) grid.innerHTML = '<div class="empty">Меню пока не заполнено.</div>';
      return;
    }

    tabsRoot.style.display = '';
    if (!active || !ordered.includes(active)) active = ordered[0];

    ordered.forEach(cat => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'tab' + (cat === active ? ' active' : '');
      btn.dataset.cat = cat;
      btn.textContent = cat;
      btn.addEventListener('click', () => { active = cat; rerender(); });
      tabsRoot.appendChild(btn);
    });
  };

  try {
    [categories, all] = await Promise.all([fetchCategories(), fetchMenu()]);
    buildTabs();
    rerender();
  } catch (e) {
    if (grid) grid.innerHTML = '<div class="empty">Не удалось загрузить меню. Проверьте, что сервер запущен.</div>';
  }

  // Modal close
  const overlay = document.getElementById('dish-modal-overlay');
  if (overlay) {
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) closeModal();
    });
    document.getElementById('modal-close').addEventListener('click', closeModal);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });
  }
});

function closeModal() {
  const overlay = document.getElementById('dish-modal-overlay');
  if (overlay) overlay.classList.remove('open');
  document.body.style.overflow = '';
}
