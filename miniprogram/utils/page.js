const { formatDateTime, toDateInput, toTimeInput } = require('../domain/time');

function getService() {
  const bootstrap = getApp().globalData.bootstrap;
  if (!bootstrap || !bootstrap.applicationService) {
    throw new Error('应用服务尚未初始化');
  }
  return bootstrap.applicationService;
}

function showError(error) {
  wx.showToast({ title: error && error.message ? error.message : '操作失败，请重试', icon: 'none', duration: 3000 });
}

function showSaved(message = '已保存') {
  wx.showToast({ title: message, icon: 'success' });
}

function selectorData(snapshot) {
  return {
    projects: [{ id: '', title: '未关联项目' }].concat(snapshot.projects.filter((item) => item.status === 'active')),
    tasks: [{ id: '', title: '未关联任务' }].concat(snapshot.tasks.filter((item) => item.status !== 'completed')),
    events: [{ id: '', title: '未关联计划块' }].concat(snapshot.calendarEvents)
  };
}

function defaultDateTime(timestamp = Date.now()) {
  return {
    date: toDateInput(timestamp),
    time: toTimeInput(timestamp)
  };
}

module.exports = {
  getService,
  showError,
  showSaved,
  selectorData,
  defaultDateTime,
  formatDateTime
};
