const test = require('node:test');
const assert = require('node:assert/strict');

const { rangeForView } = require('../miniprogram/utils/date-range');
const {
  REVIEW_SCALE,
  reviewRange,
  recentPeriods,
  parseCustomPeriod,
  periodKey,
  trendRanges,
  reviewRangeLabel
} = require('../miniprogram/utils/review-range');

function localTimestamp(year, month, day, hour = 0, minute = 0) {
  return new Date(year, month - 1, day, hour, minute, 0, 0).getTime();
}

test('当前复盘周期截止当前时刻，历史月使用完整自然月', () => {
  const now = localTimestamp(2026, 8, 22, 15, 30);
  const currentWeek = reviewRange(now, REVIEW_SCALE.WEEK, now);
  const currentMonth = reviewRange(now, REVIEW_SCALE.MONTH, now);
  const july = localTimestamp(2026, 7, 12, 12);
  const pastMonth = reviewRange(july, REVIEW_SCALE.MONTH, now);

  assert.equal(currentWeek.end, now);
  assert.equal(currentMonth.end, now);
  assert.deepEqual(pastMonth, rangeForView(july, REVIEW_SCALE.MONTH));
});

test('最近周期固定包含当前与此前四个月或年份', () => {
  const now = localTimestamp(2026, 2, 18, 12);
  assert.deepEqual(
    recentPeriods(now, REVIEW_SCALE.MONTH).map((item) => item.key),
    ['2026-02', '2026-01', '2025-12', '2025-11', '2025-10']
  );
  assert.deepEqual(
    recentPeriods(now, REVIEW_SCALE.YEAR).map((item) => item.key),
    ['2026', '2025', '2024', '2023', '2022']
  );
});

test('自定义月年严格校验格式并拒绝未来周期', () => {
  const now = localTimestamp(2026, 8, 22, 12);
  const monthAnchor = parseCustomPeriod('2025-12', REVIEW_SCALE.MONTH, now);
  const yearAnchor = parseCustomPeriod('2024', REVIEW_SCALE.YEAR, now);

  assert.equal(periodKey(monthAnchor, REVIEW_SCALE.MONTH), '2025-12');
  assert.equal(periodKey(yearAnchor, REVIEW_SCALE.YEAR), '2024');
  assert.throws(
    () => parseCustomPeriod('2026/08', REVIEW_SCALE.MONTH, now),
    /YYYY-MM/
  );
  assert.throws(
    () => parseCustomPeriod('2027', REVIEW_SCALE.YEAR, now),
    /不能晚于当前时间/
  );
});

test('周月趋势最多八周，历史月末使用完整所在周而本月截止当前时刻', () => {
  const now = localTimestamp(2026, 8, 22, 15, 30);
  const weekBuckets = trendRanges(now, REVIEW_SCALE.WEEK, now);
  const currentMonthBuckets = trendRanges(now, REVIEW_SCALE.MONTH, now);
  const julyBuckets = trendRanges(localTimestamp(2026, 7, 1, 12), REVIEW_SCALE.MONTH, now);

  assert.equal(weekBuckets.length, 8);
  assert.equal(weekBuckets.at(-1).rangeEnd, now);
  assert.equal(currentMonthBuckets.length, 8);
  assert.equal(currentMonthBuckets.at(-1).rangeEnd, now);
  assert.equal(julyBuckets.length, 8);
  assert.equal(
    julyBuckets.at(-1).rangeEnd,
    rangeForView(localTimestamp(2026, 7, 31, 23, 59), REVIEW_SCALE.WEEK).end
  );
});

test('年度趋势留在所选年内并最多显示截止锚点的六个月', () => {
  const now = localTimestamp(2026, 8, 22, 15, 30);
  const current = trendRanges(now, REVIEW_SCALE.YEAR, now);
  const past = trendRanges(localTimestamp(2025, 4, 1, 12), REVIEW_SCALE.YEAR, now);
  const januaryNow = localTimestamp(2026, 1, 8, 12);
  const january = trendRanges(januaryNow, REVIEW_SCALE.YEAR, januaryNow);

  assert.deepEqual(current.map((item) => item.label), ['3月', '4月', '5月', '6月', '7月', '8月']);
  assert.equal(current.at(-1).rangeEnd, now);
  assert.deepEqual(past.map((item) => item.label), ['7月', '8月', '9月', '10月', '11月', '12月']);
  assert.deepEqual(january.map((item) => item.label), ['1月']);
  assert.equal(reviewRangeLabel(now, REVIEW_SCALE.YEAR, now), '2026年 · 截至当前');
});
