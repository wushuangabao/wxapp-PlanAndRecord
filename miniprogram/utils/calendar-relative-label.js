const MS_PER_DAY = 24 * 60 * 60 * 1000;

function localDaySerial(timestamp) {
  const date = new Date(timestamp);
  return Math.floor(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / MS_PER_DAY);
}

function localWeekSerial(timestamp) {
  const date = new Date(timestamp);
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() - ((date.getDay() + 6) % 7));
  return Math.floor(localDaySerial(date.getTime()) / 7);
}

function distanceLabel(distance, names, unit) {
  if (Object.prototype.hasOwnProperty.call(names, distance)) return names[distance];
  return distance < 0
    ? `${Math.abs(distance)}${unit}前`
    : `${distance}${unit}后`;
}

function calendarRelativeLabel(anchor, view, now = Date.now()) {
  const target = new Date(anchor);
  const current = new Date(now);

  if (view === 'day') {
    return distanceLabel(localDaySerial(anchor) - localDaySerial(now), {
      '-2': '前天',
      '-1': '昨天',
      0: '今天',
      1: '明天',
      2: '后天'
    }, '天');
  }

  if (view === 'week') {
    return distanceLabel(localWeekSerial(anchor) - localWeekSerial(now), {
      '-1': '上周',
      0: '本周',
      1: '下周'
    }, '周');
  }

  if (view === 'month') {
    const distance = (target.getFullYear() - current.getFullYear()) * 12
      + target.getMonth() - current.getMonth();
    return distanceLabel(distance, {
      '-1': '上个月',
      0: '本月',
      1: '下个月'
    }, '个月');
  }

  const distance = target.getFullYear() - current.getFullYear();
  return distanceLabel(distance, {
    '-1': '去年',
    0: '今年',
    1: '明年'
  }, '年');
}

module.exports = {
  calendarRelativeLabel
};
