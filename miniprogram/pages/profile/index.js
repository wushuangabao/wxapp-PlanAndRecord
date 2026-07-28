const { rangeForView } = require('../../utils/date-range');
const { getService, showError, showSaved } = require('../../utils/page');

function saveExport(fileName, content) {
  const filePath = `${wx.env.USER_DATA_PATH}/${fileName}`;
  wx.getFileSystemManager().writeFile({
    filePath,
    data: content,
    encoding: 'utf8',
    success: () => {
      wx.showToast({ title: '导出文件已生成', icon: 'success' });
      wx.openDocument({ filePath, showMenu: true, fail: () => {} });
    },
    fail: () => wx.showToast({ title: '导出失败，请重试', icon: 'none' })
  });
}

Page({
  data: {
    categories: [],
    categoryName: '',
    renameId: '',
    renameValue: '',
    includeCandidates: false,
    statistics: null,
    categoryStats: [],
    projectStats: [],
    variance: [],
    overlaps: [],
    review: null
  },

  onShow() {
    this.refresh();
  },

  refresh() {
    try {
      const service = getService();
      const snapshot = service.snapshot();
      const range = rangeForView(Date.now(), 'week');
      const statistics = service.statistics({ rangeStart: range.start, rangeEnd: range.end, includeCandidates: this.data.includeCandidates });
      this.setData({
        categories: snapshot.categories,
        statistics,
        categoryStats: statistics.categories,
        projectStats: statistics.projects,
        variance: statistics.planVariance.events,
        overlaps: statistics.overlaps,
        review: statistics.weeklyReview
      });
    } catch (error) {
      showError(error);
    }
  },

  onField(event) {
    this.setData({ [event.currentTarget.dataset.key]: event.detail.value });
  },

  onCandidatesChange(event) {
    this.setData({ includeCandidates: event.detail.value }, () => this.refresh());
  },

  addCategory() {
    try {
      getService().createCategory(this.data.categoryName);
      this.setData({ categoryName: '' });
      showSaved();
      this.refresh();
    } catch (error) { showError(error); }
  },

  startRename(event) {
    const category = event.currentTarget.dataset.item;
    this.setData({ renameId: category.id, renameValue: category.name });
  },

  saveRename() {
    try {
      getService().renameCategory(this.data.renameId, this.data.renameValue);
      this.setData({ renameId: '', renameValue: '' });
      showSaved();
      this.refresh();
    } catch (error) { showError(error); }
  },

  archiveCategory(event) {
    const id = event.currentTarget.dataset.id;
    wx.showModal({ title: '归档分类', content: '归档后不能用于新记录，历史记录中的分类名称会保留。', success: (result) => {
      if (!result.confirm) return;
      try {
        getService().archiveCategory(id);
        showSaved('分类已归档');
        this.refresh();
      } catch (error) { showError(error); }
    } });
  },

  exportJson() {
    try {
      saveExport(`plan-and-record-${Date.now()}.json`, getService().exportJson());
    } catch (error) { showError(error); }
  },

  exportCsv() {
    try {
      saveExport(`plan-and-record-logs-${Date.now()}.csv`, getService().exportLogsCsv());
    } catch (error) { showError(error); }
  }
});
