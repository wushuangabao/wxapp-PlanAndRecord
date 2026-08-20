const { localDateKey } = require('../domain/time');

const KIND_HOLIDAY = 'holiday';
const KIND_ADJUSTED_WORKDAY = 'adjustedWorkday';

function fillRange(map, startKey, endKey, kind, name) {
  const [startYear, startMonth, startDay] = startKey.split('-').map(Number);
  const [endYear, endMonth, endDay] = endKey.split('-').map(Number);
  const cursor = new Date(startYear, startMonth - 1, startDay);
  const endTime = new Date(endYear, endMonth - 1, endDay).getTime();
  while (cursor.getTime() <= endTime) {
    map[localDateKey(cursor.getTime())] = { kind, name };
    cursor.setDate(cursor.getDate() + 1);
  }
}

function buildCnHolidayDays() {
  const map = {};
  // 2025：国办发明电〔2024〕12号
  fillRange(map, '2025-01-01', '2025-01-01', KIND_HOLIDAY, '元旦');
  map['2025-01-26'] = { kind: KIND_ADJUSTED_WORKDAY, name: '春节' };
  fillRange(map, '2025-01-28', '2025-02-04', KIND_HOLIDAY, '春节');
  map['2025-02-08'] = { kind: KIND_ADJUSTED_WORKDAY, name: '春节' };
  fillRange(map, '2025-04-04', '2025-04-06', KIND_HOLIDAY, '清明节');
  map['2025-04-27'] = { kind: KIND_ADJUSTED_WORKDAY, name: '劳动节' };
  fillRange(map, '2025-05-01', '2025-05-05', KIND_HOLIDAY, '劳动节');
  fillRange(map, '2025-05-31', '2025-06-02', KIND_HOLIDAY, '端午节');
  map['2025-09-28'] = { kind: KIND_ADJUSTED_WORKDAY, name: '国庆节' };
  fillRange(map, '2025-10-01', '2025-10-08', KIND_HOLIDAY, '国庆节、中秋节');
  map['2025-10-11'] = { kind: KIND_ADJUSTED_WORKDAY, name: '国庆节' };

  // 2026：国办发明电〔2025〕7号
  fillRange(map, '2026-01-01', '2026-01-03', KIND_HOLIDAY, '元旦');
  map['2026-01-04'] = { kind: KIND_ADJUSTED_WORKDAY, name: '元旦' };
  map['2026-02-14'] = { kind: KIND_ADJUSTED_WORKDAY, name: '春节' };
  fillRange(map, '2026-02-15', '2026-02-23', KIND_HOLIDAY, '春节');
  map['2026-02-28'] = { kind: KIND_ADJUSTED_WORKDAY, name: '春节' };
  fillRange(map, '2026-04-04', '2026-04-06', KIND_HOLIDAY, '清明节');
  fillRange(map, '2026-05-01', '2026-05-05', KIND_HOLIDAY, '劳动节');
  map['2026-05-09'] = { kind: KIND_ADJUSTED_WORKDAY, name: '劳动节' };
  fillRange(map, '2026-06-19', '2026-06-21', KIND_HOLIDAY, '端午节');
  map['2026-09-20'] = { kind: KIND_ADJUSTED_WORKDAY, name: '国庆节' };
  fillRange(map, '2026-09-25', '2026-09-27', KIND_HOLIDAY, '中秋节');
  fillRange(map, '2026-10-01', '2026-10-07', KIND_HOLIDAY, '国庆节');
  map['2026-10-10'] = { kind: KIND_ADJUSTED_WORKDAY, name: '国庆节' };
  return Object.freeze(map);
}

const CN_HOLIDAY_DAYS = buildCnHolidayDays();

function lookupCnHoliday(dateKey) {
  return CN_HOLIDAY_DAYS[dateKey] || null;
}

function restDayAriaSuffix(mark) {
  if (!mark) return '';
  if (mark.kind === KIND_HOLIDAY) return `，${mark.name}，放假`;
  return '，周末';
}

function resolveRestDayMark(timestamp, view) {
  if (view !== 'week' && view !== 'month') return null;
  if (!Number.isFinite(timestamp)) return null;
  const entry = lookupCnHoliday(localDateKey(timestamp));
  if (entry) {
    return entry.kind === KIND_HOLIDAY ? { kind: KIND_HOLIDAY, name: entry.name } : null;
  }
  const weekday = new Date(timestamp).getDay();
  if (weekday === 0 || weekday === 6) return { kind: 'weekend', name: '' };
  return null;
}

module.exports = {
  KIND_ADJUSTED_WORKDAY,
  KIND_HOLIDAY,
  lookupCnHoliday,
  resolveRestDayMark,
  restDayAriaSuffix
};
