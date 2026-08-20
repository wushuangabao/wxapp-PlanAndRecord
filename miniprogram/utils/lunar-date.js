const LUNAR_MIN_YEAR = 1900;
const LUNAR_MAX_YEAR = 2100;
const LUNAR_EPOCH_UTC = Date.UTC(1900, 0, 31);
const DAY_MS = 24 * 60 * 60 * 1_000;
const CST_OFFSET_MS = 8 * 60 * 60 * 1_000;
const LUNAR_MONTHS = ['正月', '二月', '三月', '四月', '五月', '六月', '七月', '八月', '九月', '十月', '十一月', '十二月'];
const LUNAR_DAY_DIGITS = ['', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
const LUNAR_FESTIVALS = {
  '1-1': '春节',
  '1-15': '元宵',
  '5-5': '端午',
  '7-7': '七夕',
  '8-15': '中秋',
  '9-9': '重阳',
  '12-8': '腊八'
};
const SOLAR_TERM_NAMES = [
  '春分', '清明', '谷雨', '立夏', '小满', '芒种',
  '夏至', '小暑', '大暑', '立秋', '处暑', '白露',
  '秋分', '寒露', '霜降', '立冬', '小雪', '大雪',
  '冬至', '小寒', '大寒', '立春', '雨水', '惊蛰'
];

// 1900–2100 农历编码：低 4 位为闰月序号，0x10000 表示闰月为大月，其余位表示各月大小。
const LUNAR_INFO = [
  0x04bd8, 0x04ae0, 0x0a570, 0x054d5, 0x0d260, 0x0d950, 0x16554, 0x056a0, 0x09ad0, 0x055d2,
  0x04ae0, 0x0a5b6, 0x0a4d0, 0x0d250, 0x1d255, 0x0b540, 0x0d6a0, 0x0ada2, 0x095b0, 0x14977,
  0x04970, 0x0a4b0, 0x0b4b5, 0x06a50, 0x06d40, 0x1ab54, 0x02b60, 0x09570, 0x052f2, 0x04970,
  0x06566, 0x0d4a0, 0x0ea50, 0x06e95, 0x05ad0, 0x02b60, 0x186e3, 0x092e0, 0x1c8d7, 0x0c950,
  0x0d4a0, 0x1d8a6, 0x0b550, 0x056a0, 0x1a5b4, 0x025d0, 0x092d0, 0x0d2b2, 0x0a950, 0x0b557,
  0x06ca0, 0x0b550, 0x15355, 0x04da0, 0x0a5b0, 0x14573, 0x052b0, 0x0a9a8, 0x0e950, 0x06aa0,
  0x0aea6, 0x0ab50, 0x04b60, 0x0aae4, 0x0a570, 0x05260, 0x0f263, 0x0d950, 0x05b57, 0x056a0,
  0x096d0, 0x04dd5, 0x04ad0, 0x0a4d0, 0x0d4d4, 0x0d250, 0x0d558, 0x0b540, 0x0b6a0, 0x195a6,
  0x095b0, 0x049b0, 0x0a974, 0x0a4b0, 0x0b27a, 0x06a50, 0x06d40, 0x0af46, 0x0ab60, 0x09570,
  0x04af5, 0x04970, 0x064b0, 0x074a3, 0x0ea50, 0x06b58, 0x055c0, 0x0ab60, 0x096d5, 0x092e0,
  0x0c960, 0x0d954, 0x0d4a0, 0x0da50, 0x07552, 0x056a0, 0x0abb7, 0x025d0, 0x092d0, 0x0cab5,
  0x0a950, 0x0b4a0, 0x0baa4, 0x0ad50, 0x055d9, 0x04ba0, 0x0a5b0, 0x15176, 0x052b0, 0x0a930,
  0x07954, 0x06aa0, 0x0ad50, 0x05b52, 0x04b60, 0x0a6e6, 0x0a4e0, 0x0d260, 0x0ea65, 0x0d530,
  0x05aa0, 0x076a3, 0x096d0, 0x04afb, 0x04ad0, 0x0a4d0, 0x1d0b6, 0x0d250, 0x0d520, 0x0dd45,
  0x0b5a0, 0x056d0, 0x055b2, 0x049b0, 0x0a577, 0x0a4b0, 0x0aa50, 0x1b255, 0x06d20, 0x0ada0,
  0x14b63, 0x09370, 0x049f8, 0x04970, 0x064b0, 0x168a6, 0x0ea50, 0x06b20, 0x1a6c4, 0x0aae0,
  0x0a2e0, 0x0d2e3, 0x0c960, 0x0d557, 0x0d4a0, 0x0da50, 0x05d55, 0x056a0, 0x0a6d0, 0x055d4,
  0x052d0, 0x0a9b8, 0x0a950, 0x0b4a0, 0x0b6a6, 0x0ad50, 0x055a0, 0x0aba4, 0x0a5b0, 0x052b0,
  0x0b273, 0x06930, 0x07337, 0x06aa0, 0x0ad50, 0x14b55, 0x04b60, 0x0a570, 0x054e4, 0x0d160,
  0x0e968, 0x0d520, 0x0daa0, 0x16aa6, 0x056d0, 0x04ae0, 0x0a9d4, 0x0a2d0, 0x0d150, 0x0f252,
  0x0d520
];

function lunarInfo(year) {
  return LUNAR_INFO[year - LUNAR_MIN_YEAR];
}

function leapMonth(year) {
  return lunarInfo(year) & 0xf;
}

function leapDays(year) {
  if (!leapMonth(year)) return 0;
  return (lunarInfo(year) & 0x10000) ? 30 : 29;
}

function monthDays(year, month) {
  return (lunarInfo(year) & (0x10000 >> month)) ? 30 : 29;
}

function yearDays(year) {
  let total = 348;
  for (let bit = 0x8000; bit > 0x8; bit >>= 1) {
    total += (lunarInfo(year) & bit) ? 1 : 0;
  }
  return total + leapDays(year);
}

function formatLunarDay(day) {
  if (day === 10) return '初十';
  if (day === 20) return '二十';
  if (day === 30) return '三十';
  if (day < 10) return `初${LUNAR_DAY_DIGITS[day]}`;
  if (day < 20) return `十${LUNAR_DAY_DIGITS[day - 10]}`;
  return `廿${LUNAR_DAY_DIGITS[day - 20]}`;
}

function solarToLunar(timestamp) {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return null;
  const date = new Date(timestamp);
  const year = date.getFullYear();
  const month = date.getMonth() + 1;
  const day = date.getDate();
  const offset = Math.round((Date.UTC(year, month - 1, day) - LUNAR_EPOCH_UTC) / DAY_MS);
  if (offset < 0) return null;

  let remainder = offset;
  let lunarYear = LUNAR_MIN_YEAR;
  for (; lunarYear <= LUNAR_MAX_YEAR; lunarYear += 1) {
    const days = yearDays(lunarYear);
    if (remainder < days) break;
    remainder -= days;
  }
  if (lunarYear > LUNAR_MAX_YEAR) return null;

  const leap = leapMonth(lunarYear);
  const monthSlots = [];
  for (let monthIndex = 1; monthIndex <= 12; monthIndex += 1) {
    monthSlots.push({
      month: monthIndex,
      isLeap: false,
      days: monthDays(lunarYear, monthIndex)
    });
    if (monthIndex === leap) {
      monthSlots.push({
        month: monthIndex,
        isLeap: true,
        days: leapDays(lunarYear)
      });
    }
  }

  let lunarMonth = 1;
  let isLeap = false;
  for (const slot of monthSlots) {
    if (remainder < slot.days) {
      lunarMonth = slot.month;
      isLeap = slot.isLeap;
      break;
    }
    remainder -= slot.days;
  }

  return {
    year: lunarYear,
    month: lunarMonth,
    day: remainder + 1,
    isLeap
  };
}

function startOfLocalDayParts(timestamp) {
  const date = new Date(timestamp);
  return {
    year: date.getFullYear(),
    month: date.getMonth() + 1,
    day: date.getDate()
  };
}

function normalizeDegrees(value) {
  return ((value % 360) + 360) % 360;
}

function deltaTSeconds(year) {
  const t = year - 2000;
  return 62.92 + 0.32217 * t + 0.005589 * t * t;
}

function sunApparentLongitude(timestamp) {
  const year = new Date(timestamp).getUTCFullYear();
  const jd = timestamp / DAY_MS + 2440587.5 + deltaTSeconds(year) / 86400;
  const T = (jd - 2451545.0) / 36525;
  const T2 = T * T;
  const meanLongitude = 280.46646 + 36000.76983 * T + 0.0003032 * T2;
  const meanAnomaly = 357.52911 + 35999.05029 * T - 0.0001537 * T2;
  const anomalyRad = (meanAnomaly * Math.PI) / 180;
  const center = (1.914602 - 0.004817 * T - 0.000014 * T2) * Math.sin(anomalyRad)
    + (0.019993 - 0.000101 * T) * Math.sin(2 * anomalyRad)
    + 0.000289 * Math.sin(3 * anomalyRad);
  const omegaRad = ((125.04 - 1934.136 * T) * Math.PI) / 180;
  return normalizeDegrees(meanLongitude + center - 0.00569 - 0.00478 * Math.sin(omegaRad));
}

function solarTermNameForCivilDate(year, month, day) {
  const start = Date.UTC(year, month - 1, day) - CST_OFFSET_MS;
  const startLongitude = sunApparentLongitude(start);
  let endLongitude = sunApparentLongitude(start + DAY_MS);
  if (endLongitude < startLongitude) endLongitude += 360;
  for (let index = 0; index < 24; index += 1) {
    let target = index * 15;
    if (target < startLongitude) target += 360;
    if (target >= startLongitude && target < endLongitude) {
      return SOLAR_TERM_NAMES[index];
    }
  }
  return '';
}

function lunarFestivalName(timestamp, lunar) {
  if (!lunar.isLeap) {
    const festival = LUNAR_FESTIVALS[`${lunar.month}-${lunar.day}`];
    if (festival) return festival;
  }
  const { year, month, day } = startOfLocalDayParts(timestamp);
  const next = solarToLunar(new Date(year, month - 1, day + 1, 12).getTime());
  if (next && next.month === 1 && next.day === 1 && !next.isLeap) return '除夕';
  return '';
}

function formatLunarDateLabel(timestamp) {
  const lunar = solarToLunar(timestamp);
  if (!lunar || lunar.month < 1 || lunar.month > 12 || lunar.day < 1 || lunar.day > 30) {
    return '';
  }
  const monthName = `${lunar.isLeap ? '闰' : ''}${LUNAR_MONTHS[lunar.month - 1]}`;
  const label = `农历${monthName}${formatLunarDay(lunar.day)}`;
  const { year, month, day } = startOfLocalDayParts(timestamp);
  const suffixes = [];
  const festival = lunarFestivalName(timestamp, lunar);
  const solarTerm = solarTermNameForCivilDate(year, month, day);
  if (festival) suffixes.push(festival);
  if (solarTerm && solarTerm !== festival) suffixes.push(solarTerm);
  return suffixes.length ? `${label}·${suffixes.join('·')}` : label;
}

module.exports = {
  LUNAR_MAX_YEAR,
  LUNAR_MIN_YEAR,
  formatLunarDateLabel,
  solarToLunar
};
