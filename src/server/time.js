const PARIS_TIME_ZONE = 'Europe/Paris';

const parisPartsFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: PARIS_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  weekday: 'short',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23'
});

const WEEKDAY_MAP = Object.freeze({
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6
});

const FRENCH_WEEKDAYS = Object.freeze([
  'dimanche',
  'lundi',
  'mardi',
  'mercredi',
  'jeudi',
  'vendredi',
  'samedi'
]);

function getParisParts(dateInput = new Date()) {
  const date = dateInput instanceof Date ? dateInput : new Date(dateInput);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid date value: ${dateInput}`);
  }

  const parts = parisPartsFormatter.formatToParts(date);
  const byType = {};
  for (const part of parts) {
    if (part.type !== 'literal') {
      byType[part.type] = part.value;
    }
  }

  const year = Number.parseInt(byType.year, 10);
  const month = Number.parseInt(byType.month, 10);
  const day = Number.parseInt(byType.day, 10);
  const hour = Number.parseInt(byType.hour, 10) % 24;
  const minute = Number.parseInt(byType.minute, 10);
  const second = Number.parseInt(byType.second, 10);
  const weekday = WEEKDAY_MAP[byType.weekday];

  const monthStr = String(month).padStart(2, '0');
  const dayStr = String(day).padStart(2, '0');
  const hourStr = String(hour).padStart(2, '0');
  const minuteStr = String(minute).padStart(2, '0');
  const secondStr = String(second).padStart(2, '0');

  return {
    year,
    month,
    day,
    hour,
    minute,
    second,
    weekday,
    weekdayLabel: FRENCH_WEEKDAYS[weekday],
    dayKey: `${year}-${monthStr}-${dayStr}`,
    minuteOfDay: (hour * 60) + minute,
    slot15m: (hour * 4) + Math.floor(minute / 15),
    timeLabel: `${hourStr}:${minuteStr}:${secondStr}`,
    shortTimeLabel: `${hourStr}:${minuteStr}`
  };
}

function isValidDayKey(dayKey) {
  if (typeof dayKey !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(dayKey)) {
    return false;
  }

  const [year, month, day] = dayKey.split('-').map((n) => Number.parseInt(n, 10));
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    return false;
  }

  const check = new Date(Date.UTC(year, month - 1, day));
  return (
    check.getUTCFullYear() === year
    && (check.getUTCMonth() + 1) === month
    && check.getUTCDate() === day
  );
}

function normalizeDayQuery(dayParam, referenceDate = new Date()) {
  if (!dayParam) {
    return getParisParts(referenceDate).dayKey;
  }
  const trimmed = String(dayParam).trim();
  return isValidDayKey(trimmed) ? trimmed : null;
}

function shiftDayKey(dayKey, dayOffset) {
  if (!isValidDayKey(dayKey)) {
    throw new Error(`Invalid dayKey: ${dayKey}`);
  }
  const [year, month, day] = dayKey.split('-').map((n) => Number.parseInt(n, 10));
  const shifted = new Date(Date.UTC(year, month - 1, day + dayOffset));
  const y = shifted.getUTCFullYear();
  const m = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const d = String(shifted.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function getWeekdayForDayKey(dayKey) {
  if (!isValidDayKey(dayKey)) {
    throw new Error(`Invalid dayKey: ${dayKey}`);
  }
  const [year, month, day] = dayKey.split('-').map((n) => Number.parseInt(n, 10));
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return {
    weekday,
    weekdayLabel: FRENCH_WEEKDAYS[weekday]
  };
}

function parisWallClockToIso(dayKey, hour = 0, minute = 0) {
  if (!isValidDayKey(dayKey)) {
    throw new Error(`Invalid dayKey: ${dayKey}`);
  }
  const [year, month, day] = dayKey.split('-').map((n) => Number.parseInt(n, 10));
  const targetUtcWall = Date.UTC(year, month - 1, day, hour, minute, 0, 0);

  let guess = targetUtcWall;
  for (let i = 0; i < 2; i += 1) {
    const p = getParisParts(new Date(guess));
    const gotUtcWall = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, 0, 0);
    const diff = targetUtcWall - gotUtcWall;
    if (diff === 0) {
      break;
    }
    guess += diff;
  }

  return new Date(guess).toISOString();
}

function getUtcIsoNoMs(dateInput = new Date()) {
  const date = dateInput instanceof Date ? dateInput : new Date(dateInput);
  return new Date(date.getTime() - date.getMilliseconds()).toISOString();
}

function formatFrenchDate(dayKey) {
  if (!isValidDayKey(dayKey)) {
    return dayKey;
  }
  const iso = parisWallClockToIso(dayKey, 12, 0);
  return new Intl.DateTimeFormat('fr-FR', {
    timeZone: PARIS_TIME_ZONE,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric'
  }).format(new Date(iso));
}

function formatMinutesLabel(minuteOfDay) {
  if (!Number.isFinite(minuteOfDay)) {
    return '--h--';
  }
  const clamped = Math.max(0, Math.min((24 * 60) - 1, Math.round(minuteOfDay)));
  const h = String(Math.floor(clamped / 60)).padStart(2, '0');
  const m = String(clamped % 60).padStart(2, '0');
  return `${h}h${m}`;
}

module.exports = {
  PARIS_TIME_ZONE,
  FRENCH_WEEKDAYS,
  getParisParts,
  isValidDayKey,
  normalizeDayQuery,
  shiftDayKey,
  getWeekdayForDayKey,
  parisWallClockToIso,
  getUtcIsoNoMs,
  formatFrenchDate,
  formatMinutesLabel
};
