const { TASK_STATUS } = require('../../domain/constants');
const { parseLocalDateTime } = require('../../domain/time');
const { defaultDateTime, formatDateTime, getService, showError, showSaved } = require('../../utils/page');

const TODO_COLUMN_SIZE = 3;
const TODO_SWIPE_DISTANCE_RATIO = 0.15;
const TODO_SWIPE_DISTANCE_FALLBACK = 36;
const TODO_RETURN_ANIMATION_DURATION = 600;
const TODO_SNAP_ANIMATION_DURATION = 420;
const TODO_RETURN_ANIMATION_FRAME = 16;
const TODO_BOUNDARY_PULL_RESISTANCE = 0.45;
const TODO_BOUNDARY_MAX_OFFSET = 72;
const TODO_TITLE_UNLINKED_FONT_SIZE = 32;
const TODO_TITLE_LINKED_FONT_SIZE = 28;
const TODO_TITLE_MIN_FONT_SIZE = 18;
const TODO_TITLE_WIDTH_PADDING = 4;

function estimateTextWidthUnits(text) {
  return Array.from(text || '').reduce((total, character) => total + (character.charCodeAt(0) <= 0x7f ? 0.56 : 1), 0);
}

function todoTitleBaseFontSize(task) {
  return task.projectId ? TODO_TITLE_LINKED_FONT_SIZE : TODO_TITLE_UNLINKED_FONT_SIZE;
}

function calculateTodoTitleFontSize(title, availableWidthRpx, baseFontSize) {
  const widthUnits = estimateTextWidthUnits(title);
  if (!widthUnits || !Number.isFinite(availableWidthRpx)) return baseFontSize;
  const fittedFontSize = Math.floor(Math.max(0, availableWidthRpx - TODO_TITLE_WIDTH_PADDING) / widthUnits);
  return Math.max(TODO_TITLE_MIN_FONT_SIZE, Math.min(baseFontSize, fittedFontSize));
}

function buildTodoColumns(tasks) {
  return tasks.reduce((columns, task, index) => {
    const columnIndex = Math.floor(index / TODO_COLUMN_SIZE);
    if (!columns[columnIndex]) columns.push({ id: `todo_column_${columnIndex}`, tasks: [] });
    columns[columnIndex].tasks.push({ ...task, todoTitleFontSize: todoTitleBaseFontSize(task) });
    return columns;
  }, []);
}

function clampTodoColumnIndex(index, columnCount) {
  if (columnCount <= 0) return 0;
  return Math.max(0, Math.min(index, columnCount - 1));
}

function todoSwipeDistance(columnStep) {
  return columnStep > 0 ? columnStep * TODO_SWIPE_DISTANCE_RATIO : TODO_SWIPE_DISTANCE_FALLBACK;
}

function easeOutCubic(progress) {
  return 1 - Math.pow(1 - progress, 3);
}

function easeOutBack(progress) {
  const overshoot = 1.3;
  const shifted = progress - 1;
  return 1 + (overshoot + 1) * Math.pow(shifted, 3) + overshoot * Math.pow(shifted, 2);
}

function buildProjectTaskPanel(project, tasks, tab = 'active') {
  const projectTasks = tasks.filter((task) => task.projectId === project.id);
  return {
    projectId: project.id,
    projectTitle: project.title,
    activeTasks: projectTasks.filter((task) => task.status !== TASK_STATUS.COMPLETED),
    completedTasks: projectTasks.filter((task) => task.status === TASK_STATUS.COMPLETED),
    tab
  };
}

function buildTaskEditor(activeProjects, task = null, defaultProjectId = null) {
  const projectOptions = [{ id: null, title: '不关联项目' }].concat(
    activeProjects.map((project) => ({ id: project.id, title: project.title }))
  );
  const selectedProjectId = task ? task.projectId : defaultProjectId;
  const projectIndex = Math.max(0, projectOptions.findIndex((project) => project.id === selectedProjectId));
  return {
    mode: task ? 'edit' : 'create',
    taskId: task ? task.id : '',
    projectOptions,
    projectIndex,
    projectTitle: projectOptions[projectIndex].title,
    projectSelectionTouched: false
  };
}

Page({
  data: {
    projects: [],
    wishes: [],
    tasks: [],
    todoListTasks: [],
    todoListColumns: [],
    todoColumnIndex: 0,
    todoColumnStep: 0,
    todoScrollLeft: 0,
    todoScrollWithAnimation: true,
    todoBoundaryOffset: 0,
    todoBoundaryIsDragging: false,
    activeProjects: [],
    archivedProjects: [],
    projectTitle: '',
    projectDate: '',
    projectTime: '',
    projectObjective: '',
    projectKeyResult: '',
    projectCurrent: '',
    wishTitle: '',
    taskTitle: '',
    objectiveTitle: '',
    keyResultTitle: '',
    currentValue: '',
    editWishId: '',
    editWishTitle: '',
    isWishExpanded: false,
    isProjectCreateOpen: false,
    isTaskEditorOpen: false,
    isOkrEditorOpen: false,
    isProjectEditorOpen: false,
    pendingTaskProjectLinkId: '',
    taskEditor: null,
    taskProjectPicker: null,
    okrEditor: null,
    projectTaskPanel: null,
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

  onReady() {
    this.measureTodoColumn();
    this.measureTodoTitleFontSizes();
  },

  refresh({ resetTodoColumn = false } = {}) {
    try {
      const snapshot = getService().snapshot();
      const projects = snapshot.projects.map((project) => ({ ...project, deadlineText: formatDateTime(project.deadlineAt) }));
      const tasks = snapshot.tasks.slice();
      const todoListTasks = tasks;
      const todoListColumns = buildTodoColumns(todoListTasks);
      const todoColumnIndex = resetTodoColumn ? 0 : clampTodoColumnIndex(this.data.todoColumnIndex, todoListColumns.length);
      const shouldReturnToFirstColumn = resetTodoColumn && this.data.todoScrollLeft > 0;
      const currentPanel = this.data.projectTaskPanel;
      const panelProject = currentPanel && projects.find((project) => project.id === currentPanel.projectId);
      this.setData({
        projects,
        activeProjects: projects.filter((project) => project.status === 'active'),
        archivedProjects: projects.filter((project) => project.status === 'archived'),
        wishes: snapshot.wishes,
        tasks,
        todoListTasks,
        todoListColumns,
        todoColumnIndex,
        todoScrollLeft: shouldReturnToFirstColumn ? this.data.todoScrollLeft : (this.data.todoColumnStep ? todoColumnIndex * this.data.todoColumnStep : 0),
        projectTaskPanel: panelProject ? buildProjectTaskPanel(panelProject, tasks, currentPanel.tab) : null
      }, () => {
        this.measureTodoColumn();
        this.measureTodoTitleFontSizes();
        if (shouldReturnToFirstColumn) this.animateTodoScrollLeft(0);
      });
    } catch (error) {
      showError(error);
    }
  },

  measureTodoColumn() {
    if (!wx.createSelectorQuery) return;
    wx.createSelectorQuery()
      .selectAll('.todo-column')
      .boundingClientRect((rects) => {
        const first = rects && rects[0];
        if (!first || !first.width) return;
        const second = rects[1];
        const step = second ? second.left - first.left : first.width;
        const index = clampTodoColumnIndex(this.data.todoColumnIndex, this.data.todoListColumns.length);
        this.setData({
          todoColumnStep: step,
          todoColumnIndex: index,
          todoScrollLeft: this.todoScrollAnimationId !== null && this.todoScrollAnimationId !== undefined ? this.data.todoScrollLeft : index * step
        });
      })
      .exec();
  },

  measureTodoTitleFontSizes() {
    if (!wx.createSelectorQuery || !wx.getWindowInfo) return;
    const windowInfo = wx.getWindowInfo();
    if (!windowInfo || !windowInfo.windowWidth) return;
    const rpxPerPixel = 750 / windowInfo.windowWidth;
    wx.createSelectorQuery()
      .selectAll('.todo-main')
      .boundingClientRect((rects) => {
        if (!rects || !rects.length) return;
        let rectIndex = 0;
        let changed = false;
        const todoListColumns = this.data.todoListColumns.map((column) => ({
          ...column,
          tasks: column.tasks.map((task) => {
            const rect = rects[rectIndex];
            rectIndex += 1;
            if (!rect || !rect.width) return task;
            const fontSize = calculateTodoTitleFontSize(task.title, rect.width * rpxPerPixel, todoTitleBaseFontSize(task));
            if (task.todoTitleFontSize !== fontSize) {
              changed = true;
              return { ...task, todoTitleFontSize: fontSize };
            }
            return task;
          })
        }));
        if (changed) this.setData({ todoListColumns });
      })
      .exec();
  },

  clearTodoScrollAnimation() {
    if (this.todoScrollAnimationId !== null && this.todoScrollAnimationId !== undefined) clearTimeout(this.todoScrollAnimationId);
    this.todoScrollAnimationId = null;
  },

  animateTodoScrollLeft(targetScrollLeft, options = {}) {
    this.clearTodoScrollAnimation();
    const startScrollLeft = Number.isFinite(options.startScrollLeft) ? options.startScrollLeft : this.data.todoScrollLeft;
    const duration = options.duration || TODO_RETURN_ANIMATION_DURATION;
    const easing = options.easing || easeOutCubic;
    if (startScrollLeft === targetScrollLeft) {
      this.setData({ todoScrollLeft: targetScrollLeft, todoScrollWithAnimation: false });
      return;
    }

    const startedAt = Date.now();
    this.setData({ todoScrollLeft: startScrollLeft, todoScrollWithAnimation: false });
    const step = () => {
      const progress = Math.min(1, (Date.now() - startedAt) / duration);
      const scrollLeft = progress === 0
        ? startScrollLeft
        : startScrollLeft + (targetScrollLeft - startScrollLeft) * easing(progress);
      this.setData({ todoScrollLeft: scrollLeft });
      if (progress < 1) {
        this.todoScrollAnimationId = setTimeout(step, TODO_RETURN_ANIMATION_FRAME);
        return;
      }
      this.todoScrollAnimationId = null;
      this.setData({ todoScrollLeft: targetScrollLeft, todoScrollWithAnimation: false });
    };
    step();
  },

  snapTodoColumn(index, currentScrollLeft) {
    this.clearTodoScrollAnimation();
    const currentIndex = clampTodoColumnIndex(this.data.todoColumnIndex, this.data.todoListColumns.length);
    const nextIndex = clampTodoColumnIndex(index, this.data.todoListColumns.length);
    const targetScrollLeft = this.data.todoColumnStep ? nextIndex * this.data.todoColumnStep : 0;
    this.setData({ todoColumnIndex: nextIndex });
    if (!Number.isFinite(currentScrollLeft)) {
      this.setData({ todoScrollLeft: targetScrollLeft, todoScrollWithAnimation: true });
      return;
    }
    this.animateTodoScrollLeft(targetScrollLeft, {
      startScrollLeft: currentScrollLeft,
      duration: TODO_SNAP_ANIMATION_DURATION,
      easing: nextIndex === currentIndex ? easeOutCubic : easeOutBack
    });
  },

  onTodoTouchStart(event) {
    this.clearTodoScrollAnimation();
    if (this.data.todoBoundaryOffset || this.data.todoBoundaryIsDragging) {
      this.setData({ todoBoundaryOffset: 0, todoBoundaryIsDragging: false });
    }
    const touch = event.touches && event.touches[0];
    this.todoTouchStartX = touch ? touch.pageX : null;
    this.todoTouchStartScrollLeft = this.data.todoScrollLeft;
    this.todoScrollLeft = this.data.todoScrollLeft;
  },

  onTodoTouchMove(event) {
    const touch = event.touches && event.touches[0];
    if (!touch || this.todoTouchStartX === null || this.todoTouchStartX === undefined) return;
    const dragDistance = touch.pageX - this.todoTouchStartX;
    if (this.data.todoColumnIndex !== 0 || dragDistance <= 0) {
      if (this.data.todoBoundaryOffset || this.data.todoBoundaryIsDragging) {
        this.setData({ todoBoundaryOffset: 0, todoBoundaryIsDragging: false });
      }
      return;
    }
    this.setData({
      todoBoundaryOffset: Math.min(TODO_BOUNDARY_MAX_OFFSET, dragDistance * TODO_BOUNDARY_PULL_RESISTANCE),
      todoBoundaryIsDragging: true
    });
  },

  onTodoScroll(event) {
    this.todoScrollLeft = event.detail.scrollLeft;
  },

  onTodoTouchEnd(event) {
    const touch = event.changedTouches && event.changedTouches[0];
    const endX = touch ? touch.pageX : null;
    const deltaX = this.todoTouchStartX === null || endX === null ? 0 : this.todoTouchStartX - endX;
    const touchStartScrollLeft = Number.isFinite(this.todoTouchStartScrollLeft)
      ? this.todoTouchStartScrollLeft
      : this.data.todoScrollLeft;
    const currentLeft = Math.max(0, touchStartScrollLeft + deltaX);
    const swipeDirection = deltaX > 0 ? 1 : -1;
    const requestedIndex = this.data.todoColumnIndex + swipeDirection;
    const isFirstColumnPull = this.data.todoColumnIndex === 0 && this.data.todoBoundaryIsDragging;
    this.todoTouchStartX = null;
    this.todoTouchStartScrollLeft = null;
    if (isFirstColumnPull) {
      this.setData({ todoBoundaryOffset: 0, todoBoundaryIsDragging: false });
      this.snapTodoColumn(this.data.todoColumnIndex);
      return;
    }
    const nextIndex = Math.abs(deltaX) >= todoSwipeDistance(this.data.todoColumnStep)
      ? requestedIndex
      : this.data.todoColumnIndex;
    this.snapTodoColumn(nextIndex, currentLeft);
  },

  onField(event) {
    this.setData({ [event.currentTarget.dataset.key]: event.detail.value });
  },

  openProjectCreate() {
    this.setData({ isProjectCreateOpen: true, pendingTaskProjectLinkId: '' });
  },

  closeProjectCreate() {
    this.setData({ isProjectCreateOpen: false, pendingTaskProjectLinkId: '' });
  },

  addProject() {
    try {
      const deadlineAt = parseLocalDateTime(this.data.projectDate, this.data.projectTime);
      const pendingTaskProjectLinkId = this.data.pendingTaskProjectLinkId;
      const objectiveTitle = this.data.projectObjective.trim();
      const keyResultTitle = this.data.projectKeyResult.trim();
      if (pendingTaskProjectLinkId && !getService().snapshot().tasks.some((task) => task.id === pendingTaskProjectLinkId)) {
        throw new Error('要关联的 TODO 已不存在，请重新选择');
      }
      if (keyResultTitle && !objectiveTitle) {
        throw new Error('填写关键结果前请先填写目标名称');
      }
      const objectives = objectiveTitle ? [{
        title: objectiveTitle,
        keyResults: keyResultTitle ? [{
          title: keyResultTitle,
          currentValue: this.data.projectCurrent === '' ? 0 : Number(this.data.projectCurrent)
        }] : []
      }] : [];
      const project = getService().createProject({
        title: this.data.projectTitle,
        deadlineAt,
        objectives
      });
      if (pendingTaskProjectLinkId) getService().updateTask(pendingTaskProjectLinkId, { projectId: project.id });
      this.setData({
        isProjectCreateOpen: false,
        pendingTaskProjectLinkId: '',
        projectTitle: '',
        projectObjective: '',
        projectKeyResult: '',
        projectCurrent: ''
      });
      showSaved(pendingTaskProjectLinkId ? '项目已创建并关联 TODO' : '项目已创建');
      this.refresh();
    } catch (error) {
      showError(error);
    }
  },

  openStandaloneTask() {
    const editor = this.data.taskEditor;
    if (editor && !this.data.isTaskEditorOpen && editor.mode === 'create' && !editor.taskId) {
      this.setData({ isTaskEditorOpen: true });
      return;
    }
    this.setData({ taskEditor: buildTaskEditor(this.data.activeProjects), taskTitle: '', isTaskEditorOpen: true });
  },

  openChildTask(event) {
    const project = this.data.activeProjects.find((item) => item.id === event.currentTarget.dataset.id);
    if (!project) return;
    const editor = this.data.taskEditor;
    const selectedProject = editor && editor.projectOptions[editor.projectIndex];
    if (editor && !this.data.isTaskEditorOpen && editor.mode === 'create' && !editor.taskId && selectedProject && selectedProject.id === project.id) {
      this.setData({ isTaskEditorOpen: true });
      return;
    }
    this.setData({ taskEditor: buildTaskEditor(this.data.activeProjects, null, project.id), taskTitle: '', isTaskEditorOpen: true });
  },

  openTaskEditor(event) {
    const task = this.data.tasks.find((item) => item.id === event.currentTarget.dataset.id);
    if (!task) return;
    const editor = this.data.taskEditor;
    if (editor && !this.data.isTaskEditorOpen && editor.mode === 'edit' && editor.taskId === task.id) {
      this.setData({ isTaskEditorOpen: true });
      return;
    }
    this.setData({ taskEditor: buildTaskEditor(this.data.activeProjects, task), taskTitle: task.title, isTaskEditorOpen: true });
  },

  closeTaskEditor() {
    this.setData({ taskEditor: null, taskTitle: '', isTaskEditorOpen: false });
  },

  dismissTaskEditor() {
    if (!this.data.taskEditor) return;
    this.setData({ isTaskEditorOpen: false });
  },

  onTaskProjectChange(event) {
    const editor = this.data.taskEditor;
    const projectIndex = Number(event.detail.value);
    if (!editor || !Number.isInteger(projectIndex) || !editor.projectOptions[projectIndex]) return;
    this.setData({
      taskEditor: {
        ...editor,
        projectIndex,
        projectTitle: editor.projectOptions[projectIndex].title,
        projectSelectionTouched: true
      }
    });
  },

  saveTaskEditor() {
    try {
      const editor = this.data.taskEditor;
      if (!editor) throw new Error('请先选择任务入口');
      const selectedProject = editor.projectOptions[editor.projectIndex];
      if (!selectedProject) throw new Error('请选择关联项目');
      const projectId = selectedProject.id;
      if (editor.mode === 'edit') {
        const input = { title: this.data.taskTitle };
        if (editor.projectSelectionTouched) input.projectId = projectId;
        getService().updateTask(editor.taskId, input);
      } else {
        getService().createTask({ title: this.data.taskTitle, status: TASK_STATUS.TODO, projectId });
      }
      this.closeTaskEditor();
      showSaved(editor.mode === 'edit' ? 'TODO 已更新' : 'TODO 已创建');
      this.refresh({ resetTodoColumn: editor.mode !== 'edit' });
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

  chooseTaskProject(event) {
    const task = this.data.tasks.find((item) => item.id === event.currentTarget.dataset.id);
    if (!task) return;
    const activeProjects = this.data.activeProjects;
    if (!activeProjects.length) {
      this.setData({ isProjectCreateOpen: true, pendingTaskProjectLinkId: task.id });
      return;
    }
    const projects = activeProjects
      .filter((project) => project.id !== task.projectId)
      .map((project) => ({ id: project.id, title: project.title }));
    this.setData({
      taskProjectPicker: {
        taskId: task.id,
        title: task.projectId ? '更改所属项目' : '添加到项目…',
        projects,
        optionsHeight: Math.min((projects.length + (task.projectId ? 1 : 0)) * 96, 480),
        canUnlink: Boolean(task.projectId)
      }
    });
  },

  closeTaskProjectPicker() {
    this.setData({ taskProjectPicker: null });
  },

  selectTaskProject(event) {
    try {
      const picker = this.data.taskProjectPicker;
      const project = picker && this.data.activeProjects.find((item) => item.id === event.currentTarget.dataset.id);
      if (!picker || !project) return;
      getService().updateTask(picker.taskId, { projectId: project.id });
      this.closeTaskProjectPicker();
      showSaved('已关联项目');
      this.refresh();
    } catch (error) {
      showError(error);
    }
  },

  unlinkTaskProject() {
    try {
      const picker = this.data.taskProjectPicker;
      if (!picker || !picker.canUnlink) return;
      getService().updateTask(picker.taskId, { projectId: null });
      this.closeTaskProjectPicker();
      showSaved('已取消关联');
      this.refresh();
    } catch (error) {
      showError(error);
    }
  },

  confirmDeleteTask(event) {
    const id = event.currentTarget.dataset.id;
    wx.showModal({
      title: '删除任务',
      content: '未结束的关联计划会一并删除；已结束计划和计时记录会保留。',
      confirmColor: '#9a5550',
      success: (result) => {
        if (!result.confirm) return;
        try {
          getService().deleteTask(id, true);
          showSaved('任务已删除');
          this.refresh();
        } catch (error) {
          showError(error);
        }
      }
    });
  },

  openProjectTasks(event) {
    const project = this.data.activeProjects.find((item) => item.id === event.currentTarget.dataset.id);
    if (!project) return;
    this.setData({ projectTaskPanel: buildProjectTaskPanel(project, this.data.tasks) });
  },

  switchProjectTaskTab(event) {
    const panel = this.data.projectTaskPanel;
    if (!panel) return;
    this.setData({ projectTaskPanel: { ...panel, tab: event.currentTarget.dataset.tab } });
  },

  closeProjectTasks() {
    this.setData({ projectTaskPanel: null });
  },

  openKeyResult(event) {
    const project = this.data.activeProjects.find((item) => item.id === event.currentTarget.dataset.id);
    if (!project) return;
    const editor = this.data.okrEditor;
    if (editor && !this.data.isOkrEditorOpen && editor.id === project.id) {
      this.setData({ isOkrEditorOpen: true });
      return;
    }
    this.setData({ okrEditor: project, objectiveTitle: '', keyResultTitle: '', currentValue: '', isOkrEditorOpen: true });
  },

  closeKeyResult() {
    this.setData({ okrEditor: null, objectiveTitle: '', keyResultTitle: '', currentValue: '', isOkrEditorOpen: false });
  },

  dismissKeyResult() {
    if (!this.data.okrEditor) return;
    this.setData({ isOkrEditorOpen: false });
  },

  saveKeyResult() {
    try {
      const editor = this.data.okrEditor;
      if (!editor) throw new Error('请先选择项目');
      const project = getService().snapshot().projects.find((item) => item.id === editor.id);
      if (!project) throw new Error('项目不存在或已被删除');
      const objectives = project.objectives.map((objective) => ({ ...objective, keyResults: objective.keyResults.slice() }));
      const objectiveTitle = this.data.objectiveTitle.trim();
      const existing = objectives.find((item) => item.title === objectiveTitle);
      const keyResult = { title: this.data.keyResultTitle, currentValue: Number(this.data.currentValue) };
      if (existing) existing.keyResults.push(keyResult);
      else objectives.push({ title: objectiveTitle, keyResults: [keyResult] });
      getService().updateProject(project.id, { objectives });
      this.closeKeyResult();
      showSaved('关键结果已保存');
      this.refresh();
    } catch (error) {
      showError(error);
    }
  },

  openProjectManage(event) {
    const project = this.data.activeProjects.find((item) => item.id === event.currentTarget.dataset.id);
    if (!project) return;
    wx.showActionSheet({
      itemList: ['编辑项目', '归档项目', '放弃项目'],
      success: (result) => {
        if (result.tapIndex === 0) this.openProjectEditorByProject(project);
        if (result.tapIndex === 1) this.archiveProjectById(project.id);
        if (result.tapIndex === 2) this.abandonProjectById(project.id);
      }
    });
  },

  openProjectEditorByProject(project) {
    const deadline = defaultDateTime(project.deadlineAt);
    const editor = this.data.projectEditor;
    if (editor && !this.data.isProjectEditorOpen && editor.id === project.id) {
      this.setData({ isProjectEditorOpen: true });
      return;
    }
    this.setData({
      projectEditor: project,
      projectEditorTitle: project.title,
      projectEditorDate: deadline.date,
      projectEditorTime: deadline.time,
      isProjectEditorOpen: true
    });
  },

  closeProjectEditor() {
    this.setData({ projectEditor: null, isProjectEditorOpen: false });
  },

  dismissProjectEditor() {
    if (!this.data.projectEditor) return;
    this.setData({ isProjectEditorOpen: false });
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
    } catch (error) {
      showError(error);
    }
  },

  archiveProjectById(id) {
    wx.showModal({
      title: '归档项目',
      content: '归档后项目会从活动列表移除，历史数据会保留。',
      success: (result) => {
        if (!result.confirm) return;
        try {
          getService().setProjectArchived(id, true);
          showSaved('项目已归档');
          this.refresh();
        } catch (error) {
          showError(error);
        }
      }
    });
  },

  restoreProject(event) {
    try {
      getService().setProjectArchived(event.currentTarget.dataset.id, false);
      showSaved('项目已恢复为活动状态');
      this.refresh();
    } catch (error) {
      showError(error);
    }
  },

  abandonProjectById(id) {
    wx.showModal({
      title: '放弃项目',
      content: '将删除项目、未完成任务、未来计划、重复规则和候选记录；已完成任务、历史计划和已确认记录会保留。',
      confirmColor: '#9a5550',
      success: (result) => {
        if (!result.confirm) return;
        try {
          getService().abandonProject(id, true);
          showSaved('项目已放弃');
          this.refresh();
        } catch (error) {
          showError(error);
        }
      }
    });
  },

  toggleWishSection() {
    this.setData({ isWishExpanded: !this.data.isWishExpanded });
  },

  addWish() {
    try {
      getService().createWish(this.data.wishTitle);
      this.setData({ wishTitle: '' });
      showSaved('愿望已添加');
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
    } catch (error) {
      showError(error);
    }
  },

  onUnload() {
    this.clearTodoScrollAnimation();
  },

  onResize() {
    this.measureTodoColumn();
    this.measureTodoTitleFontSizes();
  },

  noop() {}
});
