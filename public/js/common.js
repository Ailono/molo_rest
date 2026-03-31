function setActiveNav() {
  const path = window.location.pathname.replace(/\/$/, '') || '/';
  const map = {
    '/': 'nav-home',
    '/index.html': 'nav-home',
    '/menu': 'nav-menu',
    '/menu.html': 'nav-menu',
    '/reviews': 'nav-reviews',
    '/reviews.html': 'nav-reviews',
    '/contacts': 'nav-contacts',
    '/contacts.html': 'nav-contacts'
  };
  const id = map[path];
  if (!id) return;
  const el = document.getElementById(id);
  if (el) el.classList.add('active');
}

document.addEventListener('DOMContentLoaded', setActiveNav);
