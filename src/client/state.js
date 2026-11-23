export function readBootstrapState() {
  const el = document.getElementById('annecypark-state');
  if (!el || !el.textContent) {
    return null;
  }
  try {
    return JSON.parse(el.textContent);
  } catch {
    return null;
  }
}

export function isDarkThemeRendered() {
  const meta = document.querySelector('meta[name="color-scheme"]');
  const content = meta ? meta.getAttribute('content') : 'light dark';
  if (content === 'dark') {
    return true;
  }
  if (content === 'light') {
    return false;
  }
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

export function getParisTimeParts(isoOrDate) {
  const d = isoOrDate instanceof Date ? isoOrDate : new Date(isoOrDate);
  if (Number.isNaN(d.getTime())) {
    return { hour: 0, minute: 0, minuteOfDay: 0, label: '--:--' };
  }
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Paris',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(d);

  const byType = {};
  for (const p of parts) {
    if (p.type !== 'literal') {
      byType[p.type] = p.value;
    }
  }
  const hour = Number.parseInt(byType.hour, 10) % 24;
  const minute = Number.parseInt(byType.minute, 10);
  const hStr = String(hour).padStart(2, '0');
  const mStr = String(minute).padStart(2, '0');
  return {
    hour,
    minute,
    minuteOfDay: (hour * 60) + minute,
    label: `${hStr}h${mStr}`
  };
}
