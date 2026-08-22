const { rangeForView, shiftAnchor } = require('./date-range');

const REVIEW_SCALE = {
  WEEK: 'week',
  MONTH: 'month',
  YEAR: 'year'
};

function sameRange(first, second) {
  return first.start === second.start && first.end === second.end;
}

function capCurrentRange(range, scale, now) {
  const currentRange = rangeForView(now, scale);
  if (range.start !== currentRange.start) return range;
  return { start: range.start, end: Math.min(range.end, now) };
}

function reviewRange(anchor, scale, now) {
  if (!Object.values(REVIEW_SCALE).includes(scale)) {
    throw new Error('复盘时间刻度无效');
  }
  return capCurrentRange(rangeForView(anchor, scale), scale, now);
}

function localAnchor(year, monthIndex = 0) {
  const date = new Date(0);
  date.setFullYear(year, monthIndex, 1);
  date.setHours(12, 0, 0, 0);
  return date.getTime();
}

function periodKey(anchor, scale) {
  const date = new Date(anchor);
  if (scale === REVIEW_SCALE.MONTH) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
  }
  if (scale === REVIEW_SCALE.YEAR) return String(date.getFullYear());
  return 'current-week';
}

function periodLabel(anchor, scale) {
  const date = new Date(anchor);
  if (scale === REVIEW_SCALE.MONTH) {
    return `${String(date.getFullYear()).slice(-2)}.${String(date.getMonth() + 1).padStart(2, '0')}`;
  }
  return String(date.getFullYear());
}

function recentPeriods(now, scale, count = 5) {
  if (scale !== REVIEW_SCALE.MONTH && scale !== REVIEW_SCALE.YEAR) return [];
  return Array.from({ length: count }, (_, index) => {
    const anchor = shiftAnchor(now, scale, -index);
    return {
      key: periodKey(anchor, scale),
      label: periodLabel(anchor, scale),
      anchor
    };
  });
}

function parseCustomPeriod(value, scale, now) {
  const input = String(value || '').trim();
  let anchor;
  if (scale === REVIEW_SCALE.MONTH) {
    const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(input);
    if (!match) throw new Error('请输入 YYYY-MM 格式的月份');
    const year = Number(match[1]);
    if (year < 1000 || year > 9999) throw new Error('请输入有效的月份');
    anchor = localAnchor(year, Number(match[2]) - 1);
  } else if (scale === REVIEW_SCALE.YEAR) {
    if (!/^\d{4}$/.test(input)) throw new Error('请输入 YYYY 格式的年份');
    const year = Number(input);
    if (year < 1000 || year > 9999) throw new Error('请输入有效的年份');
    anchor = localAnchor(year);
  } else {
    throw new Error('本周复盘不支持自定义周期');
  }

  const requestedRange = rangeForView(anchor, scale);
  const currentRange = rangeForView(now, scale);
  if (requestedRange.start > currentRange.start) {
    throw new Error('复盘周期不能晚于当前时间');
  }
  return anchor;
}

function weekLabel(rangeStart) {
  const date = new Date(rangeStart);
  return `${date.getMonth() + 1}/${date.getDate()}`;
}

function monthLabel(rangeStart) {
  return `${new Date(rangeStart).getMonth() + 1}月`;
}

function weeklyTrendRanges(anchor, now, capFinalAtNow) {
  const ranges = [];
  for (let offset = -7; offset <= 0; offset += 1) {
    const bucketAnchor = shiftAnchor(anchor, REVIEW_SCALE.WEEK, offset);
    const bucket = rangeForView(bucketAnchor, REVIEW_SCALE.WEEK);
    ranges.push({
      id: `week:${bucket.start}`,
      label: weekLabel(bucket.start),
      rangeStart: bucket.start,
      rangeEnd: offset === 0 && capFinalAtNow ? Math.min(bucket.end, now) : bucket.end
    });
  }
  return ranges;
}

function monthlyTrendRanges(anchor, now) {
  const selectedMonth = rangeForView(anchor, REVIEW_SCALE.MONTH);
  const currentMonth = rangeForView(now, REVIEW_SCALE.MONTH);
  const current = sameRange(selectedMonth, currentMonth);
  const endpoint = current ? now : selectedMonth.end;
  return weeklyTrendRanges(endpoint, now, current);
}

function yearlyTrendRanges(anchor, now) {
  const selectedYear = rangeForView(anchor, REVIEW_SCALE.YEAR);
  const currentYear = rangeForView(now, REVIEW_SCALE.YEAR);
  const current = sameRange(selectedYear, currentYear);
  const endpoint = current ? now : selectedYear.end;
  const endpointDate = new Date(endpoint);
  const count = Math.min(6, endpointDate.getMonth() + 1);
  return Array.from({ length: count }, (_, index) => {
    const reverseOffset = count - index - 1;
    const bucketAnchor = shiftAnchor(endpoint, REVIEW_SCALE.MONTH, -reverseOffset);
    const bucket = rangeForView(bucketAnchor, REVIEW_SCALE.MONTH);
    return {
      id: `month:${bucket.start}`,
      label: monthLabel(bucket.start),
      rangeStart: bucket.start,
      rangeEnd: index === count - 1 && current ? Math.min(bucket.end, now) : bucket.end
    };
  });
}

function trendRanges(anchor, scale, now) {
  if (scale === REVIEW_SCALE.YEAR) return yearlyTrendRanges(anchor, now);
  if (scale === REVIEW_SCALE.MONTH) return monthlyTrendRanges(anchor, now);
  return weeklyTrendRanges(now, now, true);
}

function reviewRangeLabel(anchor, scale, now) {
  const date = new Date(anchor);
  if (scale === REVIEW_SCALE.WEEK) return '本周 · 截至当前';
  const current = Number.isFinite(now)
    && sameRange(rangeForView(anchor, scale), rangeForView(now, scale));
  const suffix = current ? ' · 截至当前' : '';
  if (scale === REVIEW_SCALE.MONTH) {
    return `${date.getFullYear()}年${date.getMonth() + 1}月${suffix}`;
  }
  return `${date.getFullYear()}年${suffix}`;
}

module.exports = {
  REVIEW_SCALE,
  reviewRange,
  recentPeriods,
  parseCustomPeriod,
  periodKey,
  trendRanges,
  reviewRangeLabel
};
