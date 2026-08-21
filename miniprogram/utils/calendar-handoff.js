function getHandoffStore() {
  const app = getApp();
  if (!app.globalData) app.globalData = {};
  return app.globalData;
}

function setCalendarHandoff(payload) {
  getHandoffStore().calendarHandoff = payload || null;
}

function takeCalendarHandoff() {
  const store = getHandoffStore();
  const payload = store.calendarHandoff || null;
  store.calendarHandoff = null;
  return payload;
}

function revealPlanTargetId(candidate) {
  if (!candidate) return '';
  if (candidate.kind === 'occurrence') return candidate.originOccurrenceId || '';
  return candidate.calendarEventId || '';
}

module.exports = {
  setCalendarHandoff,
  takeCalendarHandoff,
  revealPlanTargetId
};
