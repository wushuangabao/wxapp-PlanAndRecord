const { TASK_STATUS } = require('../../domain/constants');
const { parseLocalDateTime } = require('../../domain/time');
const { defaultDateTime, formatDateTime, getService, showError, showSaved } = require('../../utils/page');

Page({
  data: {
    projects: [],
    wishes: [],
    tasks: [],
    activeProjects: [],
    projectTitle: '',
    projectDate: '',
    projectTime: '',
    projectObjective: '',
    projectKeyResult: '',
    projectCurrent: '',
    wishTitle: '',
    taskTitle: '',
    taskProjectIndex: 0,
    okrProjectIndex: 0,
    objectiveTitle: '',
    keyResultTitle: '',
    currentValue: '',
    editWishId: '',
    editWishTitle: '',
    projectEditor: null,
    projectEditorTitle: '',
    projectEditorDate: '',
    projectEditorTime: ''
  },

  onLoad() {
    const deadline = defaultDateTime(Date.now() + 24 * 60 * 60 * 1000);
    this.setData({ projectDate: deadline.date, projectTime: deadline.time });
  },

  onShow() {
    this.refresh();
  },

  refresh() {
    try {
      const snapshot = getService().snapshot();
      const projects = snapshot.projects.map((project) => ({ ...project, deadlineText: formatDateTime(project.deadlineAt) }));
      this.setData({
        projects,
        activeProjects: projects.filter((project) => project.status === 'active'),
        wishes: snapshot.wishes,
        tasks: snapshot.tasks
      });
    } catch (error) {
      showError(error);
    }
  },

  onField(event) {
    this.setData({ [event.currentTarget.dataset.key]: event.detail.value });
  },

  onPicker(event) {
    this.setData({ [event.currentTarget.dataset.key]: Number(event.detail.value) });
  },

  addWish() {
    try {
      getService().createWish(this.data.wishTitle);
      this.setData({ wishTitle: '' });
      showSaved('愿望已加入想法池');
      this.refresh();
    } catch (error) {
      showError(error);
    }
  },

  addProject() {
    try {
      const deadlineAt = parseLocalDateTime(this.data.projectDate, this.data.projectTime);
      getService().createProject({
        title: this.data.projectTitle,
        deadlineAt,
        objectives: [{
          title: this.data.projectObjective,
          keyResults: [{ title: this.data.projectKeyResult, currentValue: Number(this.data.projectCurrent) }]
        }]
      });
      this.setData({ projectTitle: '', projectObjective: '', projectKeyResult: '', projectCurrent: '' });
      showSaved('项目已创建');
      this.refresh();
    } catch (error) {
      showError(error);
    }
  },

  convertWish(event) {
    try {
      getService().convertWishToProject(event.currentTarget.dataset.id);
      showSaved('愿望已转为项目');
      this.refresh();
    } catch (error) {
      showError(error);
    }
  },

  editWish(event) {
    const wish = event.currentTarget.dataset.item;
    this.setData({ editWishId: wish.id, editWishTitle: wish.title });
  },

  saveWish() {
    try {
      getService().updateWish(this.data.editWishId, this.data.editWishTitle);
      this.setData({ editWishId: '', editWishTitle: '' });
      showSaved('愿望已更新');
      this.refresh();
    } catch (error) { showError(error); }
  },

  openProjectEditor(event) {
    const project = event.currentTarget.dataset.item;
    const deadline = defaultDateTime(project.deadlineAt);
    this.setData({ projectEditor: project, projectEditorTitle: project.title, projectEditorDate: deadline.date, projectEditorTime: deadline.time });
  },

  closeProjectEditor() {
    this.setData({ projectEditor: null });
  },

  saveProjectEditor() {
    try {
      getService().updateProject(this.data.projectEditor.id, {
        title: this.data.projectEditorTitle,
        deadlineAt: parseLocalDateTime(this.data.projectEditorDate, this.data.projectEditorTime)
      });
      this.closeProjectEditor();
      showSaved('项目已更新');
      this.refresh();
    } catch (error) { showError(error); }
  },

  addTask() {
    try {
      getService().createTask({ title: this.data.taskTitle });
      this.setData({ taskTitle: '' });
      showSaved('备忘录已收集');
      this.refresh();
    } catch (error) {
      showError(error);
    }
  },

  organizeTask(event) {
    try {
      const project = this.data.activeProjects[this.data.taskProjectIndex];
      getService().updateTask(event.currentTarget.dataset.id, { status: TASK_STATUS.TODO, projectId: project ? project.id : null });
      showSaved('任务已整理');
      this.refresh();
    } catch (error) {
      showError(error);
    }
  },

  toggleTask(event) {
    try {
      const status = event.currentTarget.dataset.status === TASK_STATUS.COMPLETED ? TASK_STATUS.TODO : TASK_STATUS.COMPLETED;
      getService().updateTask(event.currentTarget.dataset.id, { status });
      showSaved(status === TASK_STATUS.COMPLETED ? '任务已完成' : '任务已重新打开');
      this.refresh();
    } catch (error) {
      showError(error);
    }
  },

  addKeyResult() {
    try {
      const project = this.data.activeProjects[this.data.okrProjectIndex];
      if (!project) throw new Error('请先创建并选择一个活动项目');
      const objectives = project.objectives.map((objective) => ({ ...objective, keyResults: objective.keyResults.slice() }));
      const existing = objectives.find((item) => item.title === this.data.objectiveTitle.trim());
      const keyResult = {
        title: this.data.keyResultTitle,
        currentValue: Number(this.data.currentValue)
      };
      if (existing) existing.keyResults.push(keyResult);
      else objectives.push({ title: this.data.objectiveTitle, keyResults: [keyResult] });
      getService().updateProject(project.id, { objectives });
      this.setData({ objectiveTitle: '', keyResultTitle: '', currentValue: '' });
      showSaved('关键结果已保存');
      this.refresh();
    } catch (error) {
      showError(error);
    }
  },

  archiveProject(event) {
    const id = event.currentTarget.dataset.id;
    wx.showModal({ title: '归档项目', content: '归档后项目会从活动列表移除，历史数据会保留。', success: (result) => {
      if (!result.confirm) return;
      try {
        getService().setProjectArchived(id, true);
        showSaved('项目已归档');
        this.refresh();
      } catch (error) { showError(error); }
    } });
  },

  abandonProject(event) {
    const id = event.currentTarget.dataset.id;
    wx.showModal({
      title: '放弃项目',
      content: '将删除项目、未完成任务、未来计划、重复规则和候选记录；已完成任务、历史计划和已确认记录会保留。',
      confirmColor: '#dc2626',
      success: (result) => {
        if (!result.confirm) return;
        try {
          getService().abandonProject(id, true);
          showSaved('项目已放弃');
          this.refresh();
        } catch (error) { showError(error); }
      }
    });
  },

  noop() {}
});
