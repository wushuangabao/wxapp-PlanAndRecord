const { startOfLocalDay, endOfLocalDay } = require('../domain/time');

function rangeForView(anchor, view) {
  const date = new Date(anchor);
  if (view === 'day') {
    return { start: startOfLocalDay(anchor), end: endOfLocalDay(anchor) };
  }
  if (view === 'week') {
    date.setHours(0, 0, 0, 0);
    date.setDate(date.getDate() - date.getDay());
    const start = date.getTime();
    date.setDate(date.getDate() + 6);
    return { start, end: endOfLocalDay(date.getTime()) };
  }
  if (view === 'month') {
    date.setHours(0, 0, 0, 0);
    date.setDate(1);
    const start = date.getTime();
    date.setMonth(date.getMonth() + 1, 0);
    return { start, end: endOfLocalDay(date.getTime()) };
  }
  date.setHours(0, 0, 0, 0);
  date.setMonth(0, 1);
  const start = date.getTime();
  date.setMonth(11, 31);
  return { start, end: endOfLocalDay(date.getTime()) };
}

function shiftAnchor(anchor, view, offset) {
  const date = new Date(anchor);
  if (view === 'day') date.setDate(date.getDate() + offset);
  if (view === 'week') date.setDate(date.getDate() + offset * 7);
  if (view === 'month') date.setMonth(date.getMonth() + offset);
  if (view === 'year') date.setFullYear(date.getFullYear() + offset);
  return date.getTime();
}

module.exports = {
  rangeForView,
  shiftAnchor
};
