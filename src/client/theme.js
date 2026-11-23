const STORAGE_KEY = 'color-scheme';

function getStoredScheme() {
  try {
    const val = localStorage.getItem(STORAGE_KEY);
    return val === 'light' || val === 'dark' ? val : null;
  } catch {
    return null;
  }
}

function setStoredScheme(value) {
  try {
    if (value === 'light' || value === 'dark') {
      localStorage.setItem(STORAGE_KEY, value);
    } else {
      localStorage.removeItem(STORAGE_KEY);
    }
  } catch {
    // Storage unavailable
  }
}

function getSystemScheme() {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function applyMetaScheme(metaEl, value) {
  metaEl.content = value || 'light dark';
  window.dispatchEvent(new CustomEvent('annecypark:themechange'));
}

export function initThemeToggle() {
  const toggleBtn = document.getElementById('themeToggleBtn');
  const metaEl = document.querySelector('meta[name="color-scheme"]');
  if (!toggleBtn || !metaEl) {
    return;
  }

  toggleBtn.addEventListener('click', () => {
    const systemScheme = getSystemScheme();
    const stored = getStoredScheme();
    const rendered = stored || systemScheme;
    const target = rendered === 'dark' ? 'light' : 'dark';

    if (target === systemScheme) {
      setStoredScheme(null);
      applyMetaScheme(metaEl, 'light dark');
    } else {
      setStoredScheme(target);
      applyMetaScheme(metaEl, target);
    }
  });

  window.addEventListener('storage', (event) => {
    if (event.key === STORAGE_KEY) {
      const next = event.newValue === 'light' || event.newValue === 'dark' ? event.newValue : 'light dark';
      applyMetaScheme(metaEl, next);
    }
  });

  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (!getStoredScheme()) {
      window.dispatchEvent(new CustomEvent('annecypark:themechange'));
    }
  });
}
