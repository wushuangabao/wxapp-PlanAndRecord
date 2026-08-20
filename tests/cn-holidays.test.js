const test = require('node:test');
const assert = require('node:assert/strict');

const {
  KIND_ADJUSTED_WORKDAY,
  KIND_HOLIDAY,
  lookupCnHoliday,
  resolveRestDayMark
} = require('../miniprogram/utils/cn-holidays');

test('查询表覆盖 2025 和 2026 法定放假与调休上班', () => {
  assert.deepEqual(lookupCnHoliday('2026-01-01'), { kind: KIND_HOLIDAY, name: '元旦' });
  assert.deepEqual(lookupCnHoliday('2026-01-04'), { kind: KIND_ADJUSTED_WORKDAY, name: '元旦' });
  assert.deepEqual(lookupCnHoliday('2026-02-14'), { kind: KIND_ADJUSTED_WORKDAY, name: '春节' });
  assert.deepEqual(lookupCnHoliday('2026-10-01'), { kind: KIND_HOLIDAY, name: '国庆节' });
  assert.deepEqual(lookupCnHoliday('2026-10-10'), { kind: KIND_ADJUSTED_WORKDAY, name: '国庆节' });
  assert.deepEqual(lookupCnHoliday('2025-10-01'), { kind: KIND_HOLIDAY, name: '国庆节、中秋节' });
  assert.equal(lookupCnHoliday('2026-08-08'), null);
  assert.equal(lookupCnHoliday('2027-01-01'), null);
});

test('周月只给放假和普通周末生成脚标，调休上班视为工作日', () => {
  const sundayWork = new Date(2026, 0, 4).getTime();
  const saturdayHoliday = new Date(2026, 3, 4).getTime();
  const weekdayHoliday = new Date(2026, 9, 1).getTime();
  const ordinarySaturday = new Date(2026, 7, 8).getTime();
  const ordinaryMonday = new Date(2026, 7, 3).getTime();

  assert.equal(resolveRestDayMark(sundayWork, 'week'), null);
  assert.equal(resolveRestDayMark(sundayWork, 'month'), null);
  assert.deepEqual(resolveRestDayMark(saturdayHoliday, 'week'), { kind: KIND_HOLIDAY, name: '清明节' });
  assert.deepEqual(resolveRestDayMark(weekdayHoliday, 'month'), { kind: KIND_HOLIDAY, name: '国庆节' });
  assert.deepEqual(resolveRestDayMark(ordinarySaturday, 'week'), { kind: 'weekend', name: '' });
  assert.equal(resolveRestDayMark(ordinaryMonday, 'week'), null);
  assert.equal(resolveRestDayMark(ordinarySaturday, 'day'), null);
  assert.equal(resolveRestDayMark(ordinarySaturday, 'year'), null);
  assert.deepEqual(
    resolveRestDayMark(new Date(2024, 0, 6).getTime(), 'week'),
    { kind: 'weekend', name: '' }
  );
});
