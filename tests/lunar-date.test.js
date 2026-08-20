const test = require('node:test');
const assert = require('node:assert/strict');

const { formatLunarDateLabel, solarToLunar } = require('../miniprogram/utils/lunar-date');

function localNoon(year, month, day) {
  return new Date(year, month - 1, day, 12, 0, 0).getTime();
}

test('按设备本地自然日换算农历月日，含闰月', () => {
  assert.equal(formatLunarDateLabel(localNoon(2026, 8, 20)), '农历七月初八');
  assert.equal(formatLunarDateLabel(localNoon(2026, 2, 17)), '农历正月初一·春节');
  assert.equal(formatLunarDateLabel(localNoon(2026, 6, 19)), '农历五月初五·端午');
  assert.equal(formatLunarDateLabel(localNoon(2026, 9, 25)), '农历八月十五·中秋');
  assert.equal(formatLunarDateLabel(localNoon(2025, 1, 29)), '农历正月初一·春节');
  assert.equal(formatLunarDateLabel(localNoon(2025, 5, 31)), '农历五月初五·端午');
  assert.equal(formatLunarDateLabel(localNoon(2025, 10, 6)), '农历八月十五·中秋');
  assert.equal(formatLunarDateLabel(localNoon(2025, 7, 25)), '农历闰六月初一');
  assert.deepEqual(solarToLunar(localNoon(2025, 8, 22)), {
    year: 2025,
    month: 6,
    day: 29,
    isLeap: true
  });
  assert.equal(formatLunarDateLabel(localNoon(2025, 8, 23)), '农历七月初一·处暑');
});

test('农历文案在节日或节气日接上短名，闰月不套用非闰月节日', () => {
  assert.equal(formatLunarDateLabel(localNoon(2026, 8, 23)), '农历七月十一·处暑');
  assert.equal(formatLunarDateLabel(localNoon(2026, 8, 22)), '农历七月初十');
  assert.equal(formatLunarDateLabel(localNoon(2026, 8, 24)), '农历七月十二');
  assert.equal(formatLunarDateLabel(localNoon(2026, 4, 5)), '农历二月十八·清明');
  assert.equal(formatLunarDateLabel(localNoon(2026, 2, 16)), '农历十二月廿九·除夕');
  assert.equal(formatLunarDateLabel(localNoon(2026, 3, 3)), '农历正月十五·元宵');
  assert.equal(formatLunarDateLabel(localNoon(2026, 8, 19)), '农历七月初七·七夕');
  assert.equal(formatLunarDateLabel(localNoon(2026, 10, 18)), '农历九月初九·重阳');
  assert.equal(formatLunarDateLabel(localNoon(2026, 1, 26)), '农历十二月初八·腊八');
  assert.equal(formatLunarDateLabel(localNoon(2006, 7, 31)), '农历七月初七·七夕');
  assert.equal(formatLunarDateLabel(localNoon(2006, 8, 30)), '农历闰七月初七');
});

test('超出农历表覆盖范围或非法时间戳时不显示', () => {
  assert.equal(formatLunarDateLabel(localNoon(1899, 12, 31)), '');
  assert.equal(formatLunarDateLabel(Number.NaN), '');
  assert.equal(formatLunarDateLabel(0), '');
});
