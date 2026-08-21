const { TASK_STATUS } = require('../../domain/constants');
const { parseLocalDateTime } = require('../../domain/time');
const { limitTitleCodePoints } = require('../../domain/validation');
const {
  defaultDateTime,
  formatDateTime,
  getPreferenceStore,
  getService,
  showError,
  showSaved
} = require('../../utils/page');
const { getRuntimeWindowWidth } = require('../../utils/wechat-runtime');
const {
  revealPlanTargetId,
  setCalendarHandoff
} = require('../../utils/calendar-handoff');

const HORIZONTAL_COLUMN_SIZE = 3;
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
const PROJECT_TASK_PREVIEW_LIMIT = 3;
const TASK_PLAN_OPTION_ROW_HEIGHT_RPX = 96;
const TASK_PLAN_OPTION_GAP_RPX = 12;
const TASK_PLAN_PICKER_MAX_LIST_HEIGHT_RPX = 600;
const TODO_SORT_FIELDS = new Set(['createdAt', 'title', 'project', 'status']);
const TODO_SORT_FIELD_OPTIONS = Object.freeze([
  { field: 'createdAt', label: '创建时间' },
  { field: 'title', label: '名称' },
  { field: 'project', label: '项目' },
  { field: 'status', label: '完成情况' }
]);
const DEFAULT_TODO_SORT_CRITERIA = Object.freeze([{ field: 'createdAt', direction: 'desc' }]);
const TODO_PLAN_FILTERS = Object.freeze([{
  value: 'all',
  label: '查看全部',
  emptyText: '还没有 TODO，点右上角 + 创建一条。'
}, {
  value: 'plan',
  label: '只看计划',
  emptyText: '当前没有关联计划的 TODO。'
}, {
  value: 'unplanned',
  label: '不看计划',
  emptyText: '当前没有未关联计划的 TODO。'
}]);

function completionUndoLogTitle(log) {
  return log.taskNameSnapshot || log.note || '时间记录';
}

function completionUndoModalContent(log) {
  const timeRange = `${formatDateTime(log.startedAt)} – ${formatDateTime(log.endedAt)}`;
  return `重新打开会删除以下时间记录：\n${completionUndoLogTitle(log)}\n${timeRange}\n是否继续？`;
}

const HORIZONTAL_LIST_CONFIGS = Object.freeze({
  todo: {
    columnsKey: 'todoListColumns',
    columnIndexKey: 'todoColumnIndex',
    columnStepKey: 'todoColumnStep',
    scrollLeftKey: 'todoScrollLeft',
    scrollWithAnimationKey: 'todoScrollWithAnimation',
    boundaryOffsetKey: 'todoBoundaryOffset',
    boundaryDraggingKey: 'todoBoundaryIsDragging',
    columnSelector: '.todo-column'
  },
  wish: {
    columnsKey: 'wishListColumns',
    columnIndexKey: 'wishColumnIndex',
    columnStepKey: 'wishColumnStep',
    scrollLeftKey: 'wishScrollLeft',
    scrollWithAnimationKey: 'wishScrollWithAnimation',
    boundaryOffsetKey: 'wishBoundaryOffset',
    boundaryDraggingKey: 'wishBoundaryIsDragging',
    columnSelector: '.wish-column'
  }
});

function estimateTextWidthUnits(text) {
  return Array.from(text || '').reduce((total, character) => total + (character.charCodeAt(0) <= 0x7f ? 0.56 : 1), 0);
}

function todoTitleBaseFontSize(task) {
  return task.projectDisplayName ? TODO_TITLE_LINKED_FONT_SIZE : TODO_TITLE_UNLINKED_FONT_SIZE;
}

function calculateTodoTitleFontSize(title, availableWidthRpx, baseFontSize) {
  const widthUnits = estimateTextWidthUnits(title);
  if (!widthUnits || !Number.isFinite(availableWidthRpx)) return baseFontSize;
  const fittedFontSize = Math.floor(Math.max(0, availableWidthRpx - TODO_TITLE_WIDTH_PADDING) / widthUnits);
  return Math.max(TODO_TITLE_MIN_FONT_SIZE, Math.min(baseFontSize, fittedFontSize));
}

function buildHorizontalColumns(items, columnPrefix, itemsKey, mapItem = (item) => item) {
  return items.reduce((columns, item, index) => {
    const columnIndex = Math.floor(index / HORIZONTAL_COLUMN_SIZE);
    if (!columns[columnIndex]) columns.push({ id: `${columnPrefix}_column_${columnIndex}`, [itemsKey]: [] });
    columns[columnIndex][itemsKey].push(mapItem(item));
    return columns;
  }, []);
}

function buildTodoColumns(tasks) {
  return buildHorizontalColumns(
    tasks,
    'todo',
    'tasks',
    (task) => ({ ...task, todoTitleFontSize: todoTitleBaseFontSize(task) })
  );
}

function cloneTodoSortCriteria(criteria) {
  return criteria.map((criterion) => ({ ...criterion }));
}

function defaultTodoSortDirection(field) {
  return field === 'createdAt' ? 'desc' : 'asc';
}

function normalizeTodoSortCriteria(criteria) {
  if (!Array.isArray(criteria)) return cloneTodoSortCriteria(DEFAULT_TODO_SORT_CRITERIA);
  const usedFields = new Set();
  const normalized = criteria.reduce((result, criterion) => {
    if (!criterion || typeof criterion !== 'object' || !TODO_SORT_FIELDS.has(criterion.field) || usedFields.has(criterion.field)) {
      return result;
    }
    usedFields.add(criterion.field);
    result.push({
      field: criterion.field,
      direction: criterion.field === 'status'
        ? 'asc'
        : (criterion.direction === 'asc' || criterion.direction === 'desc'
          ? criterion.direction
          : defaultTodoSortDirection(criterion.field))
    });
    return result;
  }, []);
  return normalized.length ? normalized : cloneTodoSortCriteria(DEFAULT_TODO_SORT_CRITERIA);
}

function loadTodoSortCriteria(preferences, profileId) {
  try {
    return normalizeTodoSortCriteria(
      preferences.read('TODO_SORT', profileId, DEFAULT_TODO_SORT_CRITERIA)
    );
  } catch (error) {
    return cloneTodoSortCriteria(DEFAULT_TODO_SORT_CRITERIA);
  }
}

function saveTodoSortCriteria(preferences, profileId, criteria) {
  try {
    return preferences.write('TODO_SORT', profileId, normalizeTodoSortCriteria(criteria));
  } catch (error) {
    return false;
  }
}

function normalizeProjectCollapsedIds(ids) {
  if (!Array.isArray(ids)) return [];
  return Array.from(new Set(ids.filter((id) => typeof id === 'string' && id)));
}

function loadProjectCollapsedIds(preferences, profileId) {
  try {
    return normalizeProjectCollapsedIds(
      preferences.read('PROJECT_COLLAPSE', profileId, [])
    );
  } catch (error) {
    return [];
  }
}

function saveProjectCollapsedIds(preferences, profileId, ids) {
  try {
    return preferences.write('PROJECT_COLLAPSE', profileId, normalizeProjectCollapsedIds(ids));
  } catch (error) {
    return false;
  }
}

function localProfileId(snapshot) {
  const profileId = snapshot && snapshot.localProfile && snapshot.localProfile.id;
  return typeof profileId === 'string' && profileId ? profileId : null;
}

function todoSortFieldLabel(field) {
  const option = TODO_SORT_FIELD_OPTIONS.find((item) => item.field === field);
  return option ? option.label : '';
}

function todoSortDirectionLabel(criterion) {
  if (criterion.field === 'status') return '未完成优先';
  if (criterion.field === 'createdAt') return criterion.direction === 'asc' ? '最早在前' : '最新在前';
  return criterion.direction === 'asc' ? '正序' : '倒序';
}

function buildTodoSortEditorItems(criteria) {
  const normalized = normalizeTodoSortCriteria(criteria);
  return normalized.map((criterion, index) => ({
    ...criterion,
    label: todoSortFieldLabel(criterion.field),
    directionLabel: todoSortDirectionLabel(criterion),
    canMoveUp: index > 0,
    canMoveDown: index < normalized.length - 1,
    canRemove: normalized.length > 1
  }));
}

function todoSortAvailableFields(criteria) {
  const usedFields = new Set(normalizeTodoSortCriteria(criteria).map((criterion) => criterion.field));
  return TODO_SORT_FIELD_OPTIONS.filter((option) => !usedFields.has(option.field)).map((option) => ({ ...option }));
}

function todoPlanFilterOption(value) {
  return TODO_PLAN_FILTERS.find((item) => item.value === value) || TODO_PLAN_FILTERS[0];
}

function taskHasPlanAssociations(task) {
  return Boolean(task && (
    task.hasPlanAssociations
    || task.entityPlanCount
    || task.repeatRuleCount
  ));
}

function taskPlanPickerListHeight(count) {
  if (!count) return 0;
  return Math.min(
    TASK_PLAN_PICKER_MAX_LIST_HEIGHT_RPX,
    count * TASK_PLAN_OPTION_ROW_HEIGHT_RPX + (count - 1) * TASK_PLAN_OPTION_GAP_RPX
  );
}

function taskPlanPickerItems(candidates) {
  return (candidates || []).map((candidate) => ({
    ...candidate,
    timeText: `${formatDateTime(candidate.startedAt)} – ${formatDateTime(candidate.endedAt)}`
  }));
}

function switchToCalendar(handoff) {
  setCalendarHandoff(handoff);
  wx.switchTab({
    url: '/pages/calendar/index',
    fail: () => setCalendarHandoff(null)
  });
}

function todoTaskMatchesPlanFilter(task, filter) {
  if (filter === 'plan') return taskHasPlanAssociations(task);
  if (filter === 'unplanned') return !taskHasPlanAssociations(task);
  return true;
}

function buildTaskViewModels(tasks, projects, planStates = new Map()) {
  const projectsById = new Map(projects.map((project) => [project.id, project]));
  return tasks.map((task) => {
    const currentProject = task.projectId ? projectsById.get(task.projectId) : null;
    const historicalProjectName = typeof task.projectNameSnapshot === 'string'
      ? task.projectNameSnapshot
      : '';
    const planState = planStates.get(task.id) || null;
    return {
      ...task,
      hasCurrentProject: Boolean(currentProject),
      projectDisplayName: currentProject
        ? currentProject.title
        : (historicalProjectName ? `原项目：${historicalProjectName}` : ''),
      topVisible: planState ? planState.topVisible : true,
      controlKind: planState ? planState.controlKind : 'checkbox',
      timerMatchesTask: Boolean(planState && planState.timerMatchesTask),
      timerStatus: planState ? planState.timerStatus : 'idle',
      recordedToday: Boolean(planState && planState.recordedToday),
      planCandidates: planState ? planState.candidates : [],
      entityPlanCount: planState ? planState.entityPlans.length : 0,
      repeatRuleCount: planState ? planState.repeatRules.length : 0,
      hasPlanAssociations: Boolean(
        planState && (
          planState.hasPlanAssociations
          || (planState.entityPlans && planState.entityPlans.length)
          || (planState.repeatRules && planState.repeatRules.length)
        )
      ),
      completionUndoLogId: planState && planState.completionUndoLog
        ? planState.completionUndoLog.id
        : ''
    };
  });
}

function sortTodoTasks(tasks, criteria) {
  return tasks
    .map((task, index) => ({ task, index }))
    .sort((left, right) => {
      for (const criterion of criteria) {
        const direction = criterion.direction === 'asc' ? 1 : -1;
        let result = 0;
        if (criterion.field === 'createdAt') {
          const leftCreatedAt = Number.isFinite(left.task.createdAt) ? left.task.createdAt : 0;
          const rightCreatedAt = Number.isFinite(right.task.createdAt) ? right.task.createdAt : 0;
          result = leftCreatedAt - rightCreatedAt;
        } else if (criterion.field === 'title') {
          result = String(left.task.title || '').localeCompare(String(right.task.title || ''), 'zh-CN');
        } else if (criterion.field === 'project') {
          const leftUnlinked = !left.task.hasCurrentProject;
          const rightUnlinked = !right.task.hasCurrentProject;
          if (leftUnlinked !== rightUnlinked) {
            result = leftUnlinked ? 1 : -1;
          } else if (!leftUnlinked) {
            result = String(left.task.projectDisplayName || '').localeCompare(String(right.task.projectDisplayName || ''), 'zh-CN');
          }
        } else if (criterion.field === 'status') {
          const leftStatus = left.task.status === TASK_STATUS.COMPLETED ? 1 : 0;
          const rightStatus = right.task.status === TASK_STATUS.COMPLETED ? 1 : 0;
          result = leftStatus - rightStatus;
        }
        if (result) return criterion.field === 'status' ? result : result * direction;
      }
      return left.index - right.index;
    })
    .map((item) => item.task);
}

function buildWishColumns(wishes) {
  return buildHorizontalColumns(wishes, 'wish', 'wishes');
}

function clampColumnIndex(index, columnCount) {
  if (columnCount <= 0) return 0;
  return Math.max(0, Math.min(index, columnCount - 1));
}

function horizontalRuntimeKey(listName, suffix) {
  return `${listName}${suffix}`;
}

function todoSwipeDistance(columnStep) {
  return columnStep > 0 ? columnStep * TODO_SWIPE_DISTANCE_RATIO : TODO_SWIPE_DISTANCE_FALLBACK;
}

function easeOutCubic(progress) {
  return 1 - Math.pow(1 - progress, 3);
}

function hasId(ids, id) {
  return ids.includes(id);
}

function toggleId(ids, id) {
  return hasId(ids, id) ? ids.filter((item) => item !== id) : ids.concat(id);
}

function sameIdList(left, right) {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

function millisecondsUntilNextLocalDay(now = Date.now()) {
  const nextDay = new Date(now);
  nextDay.setHours(24, 0, 0, 0);
  return Math.max(1, nextDay.getTime() - now + 50);
}

function buildProjectCards(activeProjects, tasks, expandedProjectIds, expandedCompletedProjectIds, collapsedProjectIds, projectDeadlineScrollIds) {
  return activeProjects.map((project) => {
    const todoTasks = tasks.filter((task) => task.projectId === project.id && task.status !== TASK_STATUS.COMPLETED);
    const completedTasks = tasks.filter((task) => task.projectId === project.id && task.status === TASK_STATUS.COMPLETED);
    const isTodoExpanded = hasId(expandedProjectIds, project.id);
    const isCompletedExpanded = hasId(expandedCompletedProjectIds, project.id);
    const isCollapsed = hasId(collapsedProjectIds, project.id);
    const remainingTodoCount = Math.max(0, todoTasks.length - PROJECT_TASK_PREVIEW_LIMIT);
    return {
      id: project.id,
      title: project.title,
      deadlineText: project.deadlineText,
      todoTasks: isTodoExpanded ? todoTasks : todoTasks.slice(0, PROJECT_TASK_PREVIEW_LIMIT),
      completedTasks: isCompletedExpanded ? completedTasks : [],
      isCollapsed,
      isDeadlineScrolling: hasId(projectDeadlineScrollIds, project.id),
      hasNoTasks: todoTasks.length === 0 && completedTasks.length === 0,
      hasNoTodoTasks: todoTasks.length === 0,
      hasMoreTodoTasks: todoTasks.length > PROJECT_TASK_PREVIEW_LIMIT,
      remainingTodoCount,
      isTodoExpanded,
      todoToggleText: isTodoExpanded ? '收起' : `查看全部 ${remainingTodoCount} 项`,
      completedCount: completedTasks.length,
      isCompletedExpanded,
      completedToggleText: isCompletedExpanded ? '收起已完成项' : `已完成 ${completedTasks.length} 项`
    };
  });
}

function buildTaskEditor(defaultProjectId = null) {
  return {
    mode: 'create',
    taskId: '',
    projectId: defaultProjectId
  };
}

Page({
  data: {
    projects: [],
    wishes: [],
    tasks: [],
    todoSortCriteria: cloneTodoSortCriteria(DEFAULT_TODO_SORT_CRITERIA),
    todoSortEditorCriteria: [],
    todoSortEditorItems: [],
    todoSortAvailableFields: [],
    isTodoSortOpen: false,
    todoPlanFilter: 'all',
    todoPlanFilterLabel: '查看全部',
    todoEmptyText: '还没有 TODO，点右上角 + 创建一条。',
    todoListTasks: [],
    todoListColumns: [],
    todoColumnIndex: 0,
    todoColumnStep: 0,
    todoScrollLeft: 0,
    todoScrollWithAnimation: true,
    todoBoundaryOffset: 0,
    todoBoundaryIsDragging: false,
    todoTitleEditTaskId: '',
    todoTitleEditValue: '',
    todoTitleEditSource: '',
    wishListColumns: [],
    wishColumnIndex: 0,
    wishColumnStep: 0,
    wishScrollLeft: 0,
    wishScrollWithAnimation: true,
    wishBoundaryOffset: 0,
    wishBoundaryIsDragging: false,
    wishTitleEditId: '',
    wishTitleEditValue: '',
    activeProjects: [],
    collapsedProjectIds: [],
    projectDeadlineScrollIds: [],
    expandedProjectIds: [],
    expandedCompletedProjectIds: [],
    projectCards: [],
    archivedProjects: [],
    projectTitle: '',
    projectDate: '',
    projectTime: '',
    wishTitle: '',
    taskTitle: '',
    isWishExpanded: false,
    isProjectCreateOpen: false,
    isTaskEditorOpen: false,
    isPlanSheetOpen: false,
    isProjectEditorOpen: false,
    pendingTaskProjectLinkId: '',
    taskEditor: null,
    planEditorInitialValue: null,
    todoEditorSnapshot: null,
    taskProjectPicker: null,
    projectEditor: null,
    projectEditorTitle: '',
    projectEditorDate: '',
    projectEditorTime: '',
    taskPlanPicker: null
  },

  onLoad() {
    const deadline = defaultDateTime(Date.now() + 24 * 60 * 60 * 1000);
    let todoSortCriteria = cloneTodoSortCriteria(DEFAULT_TODO_SORT_CRITERIA);
    let collapsedProjectIds = [];
    try {
      const profileId = localProfileId(getService().snapshot());
      const preferences = getPreferenceStore();
      this.preferenceProfileId = profileId;
      todoSortCriteria = loadTodoSortCriteria(preferences, profileId);
      collapsedProjectIds = loadProjectCollapsedIds(preferences, profileId);
    } catch (error) {
      this.preferenceProfileId = null;
    }
    this.setData({
      projectDate: deadline.date,
      projectTime: deadline.time,
      todoSortCriteria,
      collapsedProjectIds
    });
  },

  onShow() {
    this.refreshStatusesForCurrentDay();
    this.refresh();
    this.scheduleNextLocalDayRefresh();
  },

  refreshStatusesForCurrentDay() {
    try {
      const service = getService();
      if (typeof service.refreshTaskPlanStatuses === 'function') {
        service.refreshTaskPlanStatuses();
      }
    } catch (error) {
      showError(error);
    }
  },

  scheduleNextLocalDayRefresh() {
    this.clearNextLocalDayRefresh();
    this.nextLocalDayRefreshTimer = setTimeout(() => {
      this.nextLocalDayRefreshTimer = null;
      this.refreshStatusesForCurrentDay();
      this.refresh();
      this.scheduleNextLocalDayRefresh();
    }, millisecondsUntilNextLocalDay());
  },

  clearNextLocalDayRefresh() {
    if (this.nextLocalDayRefreshTimer !== null && this.nextLocalDayRefreshTimer !== undefined) {
      clearTimeout(this.nextLocalDayRefreshTimer);
    }
    this.nextLocalDayRefreshTimer = null;
  },

  onHide() {
    this.clearNextLocalDayRefresh();
    this.pendingCalendarHandoff = null;
  },

  onReady() {
    this.measureTodoColumn();
    if (this.data.isWishExpanded && this.data.wishListColumns.length) this.measureWishColumn();
    this.measureTodoTitleFontSizes();
    this.measureProjectDeadlineOverflow();
  },

  refresh({ resetTodoColumn = false, focusLatestWish = false } = {}) {
    try {
      if (focusLatestWish) this.clearWishScrollAnimation();
      const service = getService();
      const snapshot = service.snapshot();
      const profileId = localProfileId(snapshot);
      let todoSortCriteria = this.data.todoSortCriteria;
      let storedCollapsedProjectIds = this.data.collapsedProjectIds;
      const preferences = getPreferenceStore();
      if (this.preferenceProfileId === undefined) {
        this.preferenceProfileId = profileId;
      } else if (profileId !== this.preferenceProfileId) {
        todoSortCriteria = loadTodoSortCriteria(preferences, profileId);
        storedCollapsedProjectIds = loadProjectCollapsedIds(preferences, profileId);
        this.preferenceProfileId = profileId;
      }
      const projects = snapshot.projects.map((project) => ({ ...project, deadlineText: formatDateTime(project.deadlineAt) }));
      const planStates = typeof service.taskPlanStates === 'function'
        ? service.taskPlanStates()
        : new Map();
      const tasks = buildTaskViewModels(snapshot.tasks, projects, planStates);
      const wishes = snapshot.wishes.slice();
      const todoPlanFilter = todoPlanFilterOption(this.data.todoPlanFilter);
      const todoListTasks = sortTodoTasks(
        tasks.filter((task) => task.topVisible && todoTaskMatchesPlanFilter(task, todoPlanFilter.value)),
        todoSortCriteria
      );
      const todoListColumns = buildTodoColumns(todoListTasks);
      const wishListColumns = buildWishColumns(wishes);
      const activeProjects = projects.filter((project) => project.status === 'active');
      const activeProjectIds = activeProjects.map((project) => project.id);
      const projectIds = projects.map((project) => project.id);
      const collapsedProjectIds = storedCollapsedProjectIds.filter((id) => hasId(projectIds, id));
      if (collapsedProjectIds.length !== storedCollapsedProjectIds.length) {
        saveProjectCollapsedIds(preferences, profileId, collapsedProjectIds);
      }
      const projectDeadlineScrollIds = this.data.projectDeadlineScrollIds.filter((id) => hasId(activeProjectIds, id));
      const expandedProjectIds = this.data.expandedProjectIds.filter((id) => hasId(activeProjectIds, id));
      const expandedCompletedProjectIds = this.data.expandedCompletedProjectIds.filter((id) => hasId(activeProjectIds, id));
      const projectCards = buildProjectCards(
        activeProjects,
        tasks,
        expandedProjectIds,
        expandedCompletedProjectIds,
        collapsedProjectIds,
        projectDeadlineScrollIds
      );
      const todoColumnIndex = resetTodoColumn ? 0 : clampColumnIndex(this.data.todoColumnIndex, todoListColumns.length);
      const shouldFocusLatestWish = focusLatestWish && wishListColumns.length > 0;
      const wishColumnIndex = shouldFocusLatestWish
        ? wishListColumns.length - 1
        : clampColumnIndex(this.data.wishColumnIndex, wishListColumns.length);
      const shouldReturnToFirstColumn = resetTodoColumn && this.data.todoScrollLeft > 0;
      this.setData({
        projects,
        activeProjects,
        todoSortCriteria,
        todoPlanFilter: todoPlanFilter.value,
        todoPlanFilterLabel: todoPlanFilter.label,
        todoEmptyText: todoPlanFilter.emptyText,
        collapsedProjectIds,
        projectDeadlineScrollIds,
        expandedProjectIds,
        expandedCompletedProjectIds,
        projectCards,
        archivedProjects: projects.filter((project) => project.status === 'archived'),
        wishes,
        tasks,
        todoListTasks,
        todoListColumns,
        todoColumnIndex,
        todoScrollLeft: shouldReturnToFirstColumn ? this.data.todoScrollLeft : (this.data.todoColumnStep ? todoColumnIndex * this.data.todoColumnStep : 0),
        wishListColumns,
        wishColumnIndex,
        wishScrollLeft: shouldFocusLatestWish || (this.wishScrollAnimationId !== null && this.wishScrollAnimationId !== undefined)
          ? this.data.wishScrollLeft
          : (this.data.wishColumnStep ? wishColumnIndex * this.data.wishColumnStep : 0)
      }, () => {
        this.measureTodoColumn();
        if (this.data.isWishExpanded && this.data.wishListColumns.length) {
          this.measureWishColumn(shouldFocusLatestWish ? {
            preserveScrollLeft: true,
            onMeasured: ({ index, step }) => this.animateWishScrollLeft(index * step)
          } : undefined);
        }
        this.measureTodoTitleFontSizes();
        this.measureProjectDeadlineOverflow();
        if (shouldReturnToFirstColumn) this.animateTodoScrollLeft(0);
      });
    } catch (error) {
      showError(error);
    }
  },

  cycleTodoPlanFilter() {
    const currentIndex = TODO_PLAN_FILTERS.findIndex((item) => item.value === this.data.todoPlanFilter);
    const next = TODO_PLAN_FILTERS[(currentIndex + 1) % TODO_PLAN_FILTERS.length];
    this.setData({
      todoPlanFilter: next.value,
      todoPlanFilterLabel: next.label,
      todoEmptyText: next.emptyText
    }, () => this.refresh({ resetTodoColumn: true }));
  },

  openTodoSort() {
    this.setTodoSortEditor(this.data.todoSortCriteria, true);
  },

  dismissTodoSort() {
    this.setData({
      isTodoSortOpen: false,
      todoSortEditorCriteria: [],
      todoSortEditorItems: [],
      todoSortAvailableFields: []
    });
  },

  setTodoSortEditor(criteria, isOpen = this.data.isTodoSortOpen) {
    const normalized = normalizeTodoSortCriteria(criteria);
    this.setData({
      isTodoSortOpen: isOpen,
      todoSortEditorCriteria: normalized,
      todoSortEditorItems: buildTodoSortEditorItems(normalized),
      todoSortAvailableFields: todoSortAvailableFields(normalized)
    });
  },

  addTodoSortCriterion(event) {
    const field = event.currentTarget.dataset.field;
    const criteria = this.data.todoSortEditorCriteria;
    if (!TODO_SORT_FIELDS.has(field) || criteria.some((criterion) => criterion.field === field)) return;
    this.setTodoSortEditor(criteria.concat({ field, direction: defaultTodoSortDirection(field) }));
  },

  toggleTodoSortDirection(event) {
    const index = Number(event.currentTarget.dataset.index);
    const criteria = this.data.todoSortEditorCriteria;
    const criterion = criteria[index];
    if (!criterion || criterion.field === 'status') return;
    this.setTodoSortEditor(criteria.map((item, itemIndex) => itemIndex === index
      ? { ...item, direction: item.direction === 'asc' ? 'desc' : 'asc' }
      : item));
  },

  moveTodoSortCriterion(event) {
    const index = Number(event.currentTarget.dataset.index);
    const offset = event.currentTarget.dataset.direction === 'up' ? -1 : 1;
    const targetIndex = index + offset;
    const criteria = this.data.todoSortEditorCriteria;
    if (!Number.isInteger(index) || targetIndex < 0 || targetIndex >= criteria.length) return;
    const reordered = criteria.slice();
    [reordered[index], reordered[targetIndex]] = [reordered[targetIndex], reordered[index]];
    this.setTodoSortEditor(reordered);
  },

  removeTodoSortCriterion(event) {
    const index = Number(event.currentTarget.dataset.index);
    const criteria = this.data.todoSortEditorCriteria;
    if (!Number.isInteger(index) || criteria.length <= 1 || index < 0 || index >= criteria.length) return;
    this.setTodoSortEditor(criteria.filter((item, itemIndex) => itemIndex !== index));
  },

  resetTodoSort() {
    this.setTodoSortEditor(DEFAULT_TODO_SORT_CRITERIA);
  },

  saveTodoSort() {
    const criteria = normalizeTodoSortCriteria(this.data.todoSortEditorCriteria);
    let persisted = false;
    try {
      const profileId = localProfileId(getService().snapshot());
      this.preferenceProfileId = profileId;
      persisted = saveTodoSortCriteria(getPreferenceStore(), profileId, criteria);
    } catch (error) {
      persisted = false;
    }
    this.setData({
      isTodoSortOpen: false,
      todoSortCriteria: criteria,
      todoSortEditorCriteria: [],
      todoSortEditorItems: [],
      todoSortAvailableFields: []
    });
    this.refresh({ resetTodoColumn: true });
    if (persisted) showSaved('TODO 排序已更新');
    else wx.showToast({ title: '本次设置仅在当前会话生效', icon: 'none' });
  },

  measureHorizontalColumn(listName, options = {}) {
    const config = HORIZONTAL_LIST_CONFIGS[listName];
    const notifyMeasured = (index, step) => {
      if (typeof options.onMeasured === 'function') options.onMeasured({ index, step });
    };
    if (!wx.createSelectorQuery) {
      const index = clampColumnIndex(this.data[config.columnIndexKey], this.data[config.columnsKey].length);
      const step = this.data[config.columnStepKey];
      if (step) notifyMeasured(index, step);
      return;
    }
    wx.createSelectorQuery()
      .selectAll(config.columnSelector)
      .boundingClientRect((rects) => {
        const first = rects && rects[0];
        if (!first || !first.width) return;
        const second = rects[1];
        const step = second ? second.left - first.left : first.width;
        const index = clampColumnIndex(this.data[config.columnIndexKey], this.data[config.columnsKey].length);
        const animationIdKey = horizontalRuntimeKey(listName, 'ScrollAnimationId');
        this.setData({
          [config.columnStepKey]: step,
          [config.columnIndexKey]: index,
          [config.scrollLeftKey]: options.preserveScrollLeft || (this[animationIdKey] !== null && this[animationIdKey] !== undefined)
            ? this.data[config.scrollLeftKey]
            : index * step
        }, () => notifyMeasured(index, step));
      })
      .exec();
  },

  measureTodoColumn() {
    this.measureHorizontalColumn('todo');
  },

  measureWishColumn(options) {
    this.measureHorizontalColumn('wish', options);
  },

  measureTodoTitleFontSizes() {
    if (!wx.createSelectorQuery) return;
    const windowWidth = getRuntimeWindowWidth(wx);
    if (windowWidth === null) return;
    const rpxPerPixel = 750 / windowWidth;
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

  measureProjectDeadlineOverflow() {
    if (!wx.createSelectorQuery) return;
    const query = wx.createSelectorQuery();
    query.selectAll('.project-deadline-viewport').boundingClientRect();
    query.selectAll('.project-deadline-measure').boundingClientRect();
    query.exec((result) => {
      const viewportRects = result && result[0];
      const textRects = result && result[1];
      if (!viewportRects || !textRects || !viewportRects.length || !textRects.length) return;
      const projectDeadlineScrollIds = this.data.projectCards.reduce((ids, project, index) => {
        const viewportRect = viewportRects[index];
        const textRect = textRects[index];
        if (viewportRect && textRect && viewportRect.width && textRect.width > viewportRect.width + 1) ids.push(project.id);
        return ids;
      }, []);
      if (sameIdList(projectDeadlineScrollIds, this.data.projectDeadlineScrollIds)) return;
      this.setData({ projectDeadlineScrollIds }, () => this.refresh());
    });
  },

  clearHorizontalScrollAnimation(listName) {
    const animationIdKey = horizontalRuntimeKey(listName, 'ScrollAnimationId');
    if (this[animationIdKey] !== null && this[animationIdKey] !== undefined) clearTimeout(this[animationIdKey]);
    this[animationIdKey] = null;
  },

  clearTodoScrollAnimation() {
    this.clearHorizontalScrollAnimation('todo');
  },

  clearWishScrollAnimation() {
    this.clearHorizontalScrollAnimation('wish');
  },

  animateHorizontalScrollLeft(listName, targetScrollLeft, options = {}) {
    const config = HORIZONTAL_LIST_CONFIGS[listName];
    const animationIdKey = horizontalRuntimeKey(listName, 'ScrollAnimationId');
    this.clearHorizontalScrollAnimation(listName);
    const startScrollLeft = Number.isFinite(options.startScrollLeft)
      ? options.startScrollLeft
      : this.data[config.scrollLeftKey];
    const duration = options.duration || TODO_RETURN_ANIMATION_DURATION;
    const easing = options.easing || easeOutCubic;
    if (startScrollLeft === targetScrollLeft) {
      this.setData({
        [config.scrollLeftKey]: targetScrollLeft,
        [config.scrollWithAnimationKey]: false
      });
      return;
    }

    const startedAt = Date.now();
    this.setData({
      [config.scrollLeftKey]: startScrollLeft,
      [config.scrollWithAnimationKey]: false
    });
    const step = () => {
      const progress = Math.min(1, (Date.now() - startedAt) / duration);
      const scrollLeft = progress === 0
        ? startScrollLeft
        : startScrollLeft + (targetScrollLeft - startScrollLeft) * easing(progress);
      this.setData({ [config.scrollLeftKey]: scrollLeft });
      if (progress < 1) {
        this[animationIdKey] = setTimeout(step, TODO_RETURN_ANIMATION_FRAME);
        return;
      }
      this[animationIdKey] = null;
      this.setData({
        [config.scrollLeftKey]: targetScrollLeft,
        [config.scrollWithAnimationKey]: false
      });
    };
    step();
  },

  animateTodoScrollLeft(targetScrollLeft, options = {}) {
    this.animateHorizontalScrollLeft('todo', targetScrollLeft, options);
  },

  animateWishScrollLeft(targetScrollLeft, options = {}) {
    this.animateHorizontalScrollLeft('wish', targetScrollLeft, options);
  },

  snapHorizontalColumn(listName, index, currentScrollLeft) {
    const config = HORIZONTAL_LIST_CONFIGS[listName];
    this.clearHorizontalScrollAnimation(listName);
    const nextIndex = clampColumnIndex(index, this.data[config.columnsKey].length);
    const targetScrollLeft = this.data[config.columnStepKey] ? nextIndex * this.data[config.columnStepKey] : 0;
    this.setData({ [config.columnIndexKey]: nextIndex });
    if (!Number.isFinite(currentScrollLeft)) {
      this.setData({
        [config.scrollLeftKey]: targetScrollLeft,
        [config.scrollWithAnimationKey]: false
      });
      return;
    }
    this.animateHorizontalScrollLeft(listName, targetScrollLeft, {
      startScrollLeft: Math.max(0, currentScrollLeft),
      duration: TODO_SNAP_ANIMATION_DURATION,
      easing: easeOutCubic
    });
  },

  snapTodoColumn(index, currentScrollLeft) {
    this.snapHorizontalColumn('todo', index, currentScrollLeft);
  },

  snapWishColumn(index, currentScrollLeft) {
    this.snapHorizontalColumn('wish', index, currentScrollLeft);
  },

  onHorizontalTouchStart(listName, event) {
    const config = HORIZONTAL_LIST_CONFIGS[listName];
    this.clearHorizontalScrollAnimation(listName);
    if (this.data[config.boundaryOffsetKey] || this.data[config.boundaryDraggingKey]) {
      this.setData({
        [config.boundaryOffsetKey]: 0,
        [config.boundaryDraggingKey]: false
      });
    }
    const touch = event.touches && event.touches[0];
    this[horizontalRuntimeKey(listName, 'TouchStartX')] = touch ? touch.pageX : null;
    this[horizontalRuntimeKey(listName, 'TouchStartScrollLeft')] = this.data[config.scrollLeftKey];
    this[horizontalRuntimeKey(listName, 'ScrollLeft')] = this.data[config.scrollLeftKey];
  },

  onHorizontalTouchMove(listName, event) {
    const config = HORIZONTAL_LIST_CONFIGS[listName];
    const touchStartXKey = horizontalRuntimeKey(listName, 'TouchStartX');
    const touch = event.touches && event.touches[0];
    if (!touch || this[touchStartXKey] === null || this[touchStartXKey] === undefined) return;
    const dragDistance = touch.pageX - this[touchStartXKey];
    if (this.data[config.columnIndexKey] !== 0 || dragDistance <= 0) {
      if (this.data[config.boundaryOffsetKey] || this.data[config.boundaryDraggingKey]) {
        this.setData({
          [config.boundaryOffsetKey]: 0,
          [config.boundaryDraggingKey]: false
        });
      }
      return;
    }
    this.setData({
      [config.boundaryOffsetKey]: Math.min(TODO_BOUNDARY_MAX_OFFSET, dragDistance * TODO_BOUNDARY_PULL_RESISTANCE),
      [config.boundaryDraggingKey]: true
    });
  },

  onHorizontalScroll(listName, event) {
    this[horizontalRuntimeKey(listName, 'ScrollLeft')] = event.detail.scrollLeft;
  },

  onHorizontalTouchEnd(listName, event) {
    const config = HORIZONTAL_LIST_CONFIGS[listName];
    const touchStartXKey = horizontalRuntimeKey(listName, 'TouchStartX');
    const touchStartScrollLeftKey = horizontalRuntimeKey(listName, 'TouchStartScrollLeft');
    const touch = event.changedTouches && event.changedTouches[0];
    const endX = touch ? touch.pageX : null;
    const deltaX = this[touchStartXKey] === null || endX === null ? 0 : this[touchStartXKey] - endX;
    const touchStartScrollLeft = Number.isFinite(this[touchStartScrollLeftKey])
      ? this[touchStartScrollLeftKey]
      : this.data[config.scrollLeftKey];
    const currentLeft = Math.max(0, touchStartScrollLeft + deltaX);
    const swipeDirection = deltaX > 0 ? 1 : -1;
    const requestedIndex = this.data[config.columnIndexKey] + swipeDirection;
    const isFirstColumnPull = this.data[config.columnIndexKey] === 0 && this.data[config.boundaryDraggingKey];
    this[touchStartXKey] = null;
    this[touchStartScrollLeftKey] = null;
    if (isFirstColumnPull) {
      this.setData({
        [config.boundaryOffsetKey]: 0,
        [config.boundaryDraggingKey]: false
      });
      this.snapHorizontalColumn(listName, this.data[config.columnIndexKey]);
      return;
    }
    const nextIndex = Math.abs(deltaX) >= todoSwipeDistance(this.data[config.columnStepKey])
      ? requestedIndex
      : this.data[config.columnIndexKey];
    this.snapHorizontalColumn(listName, nextIndex, currentLeft);
  },

  onTodoTouchStart(event) {
    this.onHorizontalTouchStart('todo', event);
  },

  onTodoTouchMove(event) {
    this.onHorizontalTouchMove('todo', event);
  },

  onTodoScroll(event) {
    this.onHorizontalScroll('todo', event);
  },

  onTodoTouchEnd(event) {
    this.flushPendingCalendarHandoff();
    this.onHorizontalTouchEnd('todo', event);
  },

  onWishTouchStart(event) {
    this.onHorizontalTouchStart('wish', event);
  },

  onWishTouchMove(event) {
    this.onHorizontalTouchMove('wish', event);
  },

  onWishScroll(event) {
    this.onHorizontalScroll('wish', event);
  },

  onWishTouchEnd(event) {
    this.onHorizontalTouchEnd('wish', event);
  },

  onField(event) {
    this.setData({ [event.currentTarget.dataset.key]: event.detail.value });
  },

  onTitleField(event) {
    this.setData({ [event.currentTarget.dataset.key]: limitTitleCodePoints(event.detail.value) });
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
      if (pendingTaskProjectLinkId && !getService().snapshot().tasks.some((task) => task.id === pendingTaskProjectLinkId)) {
        throw new Error('要关联的 TODO 已不存在，请重新选择');
      }
      const project = getService().createProject({
        title: this.data.projectTitle,
        deadlineAt
      });
      if (pendingTaskProjectLinkId) getService().updateTask(pendingTaskProjectLinkId, { projectId: project.id });
      this.setData({
        isProjectCreateOpen: false,
        pendingTaskProjectLinkId: '',
        projectTitle: ''
      });
      showSaved(pendingTaskProjectLinkId ? '项目已创建并关联 TODO' : '项目已创建');
      this.refresh();
    } catch (error) {
      showError(error);
    }
  },

  openStandaloneTask() {
    const editor = this.data.taskEditor;
    if (editor && !this.data.isTaskEditorOpen && editor.mode === 'create' && !editor.taskId && !editor.projectId) {
      this.setData({ isTaskEditorOpen: true });
      return;
    }
    this.setData({ taskEditor: buildTaskEditor(), taskTitle: '', isTaskEditorOpen: true });
  },

  openChildTask(event) {
    const project = this.data.activeProjects.find((item) => item.id === event.currentTarget.dataset.id);
    if (!project) return;
    const editor = this.data.taskEditor;
    if (editor && !this.data.isTaskEditorOpen && editor.mode === 'create' && !editor.taskId && editor.projectId === project.id) {
      this.setData({ isTaskEditorOpen: true });
      return;
    }
    this.setData({ taskEditor: buildTaskEditor(project.id), taskTitle: '', isTaskEditorOpen: true });
  },

  openTodoTitleEditor(event) {
    const task = this.data.tasks.find((item) => item.id === event.currentTarget.dataset.id);
    if (!task) return;
    this.setData({
      todoTitleEditTaskId: task.id,
      todoTitleEditValue: task.title,
      todoTitleEditSource: event.currentTarget.dataset.editSource || 'todo'
    });
  },

  onTaskTitleLongPress(event) {
    const task = this.data.tasks.find((item) => item.id === event.currentTarget.dataset.id);
    if (!task) return;
    const candidates = taskPlanPickerItems(task.planCandidates);
    if (!candidates.length) {
      this.confirmCreatePlanForTask(task.id);
      return;
    }
    if (candidates.length === 1) {
      this.queueCalendarHandoffAfterTouch(this.revealPlanHandoff(candidates[0]));
      return;
    }
    this.setData({
      taskPlanPicker: {
        taskId: task.id,
        plans: candidates,
        listHeight: taskPlanPickerListHeight(candidates.length)
      }
    });
  },

  queueCalendarHandoffAfterTouch(handoff) {
    if (!handoff) return;
    this.pendingCalendarHandoff = handoff;
  },

  flushPendingCalendarHandoff() {
    const handoff = this.pendingCalendarHandoff;
    if (!handoff) return;
    this.pendingCalendarHandoff = null;
    switchToCalendar(handoff);
  },

  onTaskTitleTouchEnd() {
    this.flushPendingCalendarHandoff();
  },

  closeTaskPlanPicker() {
    this.setData({ taskPlanPicker: null });
  },

  selectTaskPlan(event) {
    const picker = this.data.taskPlanPicker;
    const planId = event.currentTarget.dataset.id;
    const plan = picker && picker.plans
      ? picker.plans.find((item) => item.id === planId)
      : null;
    this.setData({ taskPlanPicker: null });
    if (plan) this.jumpToPlanCandidate(plan);
  },

  revealPlanHandoff(candidate) {
    const id = revealPlanTargetId(candidate);
    if (!id || !Number.isFinite(candidate.startedAt) || !Number.isFinite(candidate.endedAt)) {
      wx.showToast({ title: '无法定位该计划', icon: 'none' });
      return null;
    }
    return {
      type: 'reveal-plan',
      id,
      startedAt: candidate.startedAt,
      endedAt: candidate.endedAt
    };
  },

  jumpToPlanCandidate(candidate) {
    const handoff = this.revealPlanHandoff(candidate);
    if (handoff) switchToCalendar(handoff);
  },

  confirmCreatePlanForTask(taskId) {
    wx.showModal({
      title: '是否创建实施计划？',
      success: (result) => {
        if (!result.confirm) return;
        switchToCalendar({ type: 'create-plan', taskId });
      }
    });
  },

  onTodoTitleInput(event) {
    const dataset = event && event.currentTarget ? event.currentTarget.dataset || {} : {};
    if (dataset.id && (
      dataset.id !== this.data.todoTitleEditTaskId
      || (dataset.editSource && dataset.editSource !== this.data.todoTitleEditSource)
    )) return;
    this.setData({ todoTitleEditValue: limitTitleCodePoints(event.detail.value) });
  },

  saveTodoTitle(event) {
    const dataset = event && event.currentTarget ? event.currentTarget.dataset || {} : {};
    const taskId = dataset.id || this.data.todoTitleEditTaskId;
    const editSource = dataset.editSource || this.data.todoTitleEditSource;
    if (!taskId) return;
    const clearCurrentEditor = () => {
      if (
        this.data.todoTitleEditTaskId !== taskId
        || this.data.todoTitleEditSource !== editSource
      ) return;
      this.setData({ todoTitleEditTaskId: '', todoTitleEditValue: '', todoTitleEditSource: '' });
    };
    const task = this.data.tasks.find((item) => item.id === taskId);
    if (!task) {
      clearCurrentEditor();
      return;
    }
    const hasEventValue = Boolean(event && event.detail && typeof event.detail.value === 'string');
    const isCurrentEditor = this.data.todoTitleEditTaskId === taskId
      && this.data.todoTitleEditSource === editSource;
    if (!hasEventValue && !isCurrentEditor) return;
    const title = limitTitleCodePoints(hasEventValue ? event.detail.value : this.data.todoTitleEditValue);
    if (title === task.title) {
      clearCurrentEditor();
      return;
    }
    const applyTitle = () => {
      try {
        getService().updateTask(taskId, { title });
        clearCurrentEditor();
        this.refresh();
      } catch (error) {
        showError(error);
      }
    };
    if (!taskHasPlanAssociations(task)) {
      applyTitle();
      return;
    }
    const pending = this.pendingTodoTitleSave;
    if (pending && pending.taskId === taskId && pending.title === title) return;
    this.pendingTodoTitleSave = { taskId, title, editSource };
    const clearPending = () => {
      if (
        this.pendingTodoTitleSave
        && this.pendingTodoTitleSave.taskId === taskId
        && this.pendingTodoTitleSave.title === title
      ) {
        this.pendingTodoTitleSave = null;
      }
    };
    wx.showModal({
      title: '确认要修改任务标题？',
      success: (result) => {
        clearPending();
        if (!result.confirm) {
          clearCurrentEditor();
          return;
        }
        applyTitle();
      },
      fail: clearPending
    });
  },

  closeTaskEditor() {
    this.setData({ taskEditor: null, taskTitle: '', isTaskEditorOpen: false });
  },

  dismissTaskEditor() {
    if (!this.data.taskEditor) return;
    this.setData({ isTaskEditorOpen: false });
  },

  openPlanFromTodo() {
    if (!this.data.taskEditor || !this.data.isTaskEditorOpen) return;
    const snapshot = {
      taskTitle: this.data.taskTitle,
      taskEditor: this.data.taskEditor
    };
    this.setData({
      todoEditorSnapshot: snapshot,
      isTaskEditorOpen: false,
      isPlanSheetOpen: true,
      planEditorInitialValue: {
        title: this.data.taskTitle || '',
        anchorDate: Date.now(),
        priority: 1,
        hasAnyTasks: false,
        taskOptions: [],
        taskIndex: 0,
        newTaskProjectId: this.data.taskEditor.projectId || null
      }
    });
  },

  onPlanEditorCancel() {
    const snapshot = this.data.todoEditorSnapshot;
    this.setData({
      isPlanSheetOpen: false,
      planEditorInitialValue: null,
      taskEditor: snapshot ? snapshot.taskEditor : this.data.taskEditor,
      taskTitle: snapshot ? snapshot.taskTitle : this.data.taskTitle,
      isTaskEditorOpen: true,
      todoEditorSnapshot: null
    });
  },

  onPlanEditorSuccess() {
    this.setData({
      isPlanSheetOpen: false,
      planEditorInitialValue: null,
      todoEditorSnapshot: null,
      taskEditor: null,
      taskTitle: '',
      isTaskEditorOpen: false
    }, () => {
      showSaved('计划块已创建');
      this.refresh({ resetTodoColumn: true });
    });
  },

  saveTaskEditor() {
    try {
      const editor = this.data.taskEditor;
      if (!editor) throw new Error('请先选择任务入口');
      getService().createTask({ title: this.data.taskTitle, projectId: editor.projectId || null });
      this.closeTaskEditor();
      showSaved('TODO 已创建');
      this.refresh({ resetTodoColumn: true });
    } catch (error) {
      showError(error);
    }
  },

  toggleTask(event) {
    const id = event.currentTarget.dataset.id;
    const task = this.data.tasks.find((item) => item.id === id);
    if (!task) return;
    if (task.status === TASK_STATUS.COMPLETED && task.completionUndoLogId) {
      let undoLog;
      try {
        undoLog = getService().taskCompletionUndoPreview(task.id);
      } catch (error) {
        showError(error);
        return;
      }
      wx.showModal({
        title: '重新打开任务',
        content: completionUndoModalContent(undoLog),
        confirmColor: '#9a5550',
        success: (result) => {
          if (!result.confirm) return;
          try {
            getService().reopenTaskByRemovingCompletionLog(task.id, undoLog.id, true);
            showSaved('任务已重新打开');
            this.refresh();
          } catch (error) {
            showError(error);
          }
        }
      });
      return;
    }
    if (task.status !== TASK_STATUS.COMPLETED && task.controlKind === 'timer') {
      this.startTimerForTask(task);
      return;
    }
    if (task.status !== TASK_STATUS.COMPLETED && task.controlKind === 'recorded') {
      wx.showToast({ title: '今天的固定日程已记录', icon: 'none' });
      return;
    }
    if (task.status !== TASK_STATUS.COMPLETED && task.controlKind === 'schedule') {
      wx.showToast({ title: '今天没有这项固定日程', icon: 'none' });
      return;
    }
    try {
      const status = task.status === TASK_STATUS.COMPLETED ? TASK_STATUS.TODO : TASK_STATUS.COMPLETED;
      getService().updateTask(task.id, { status });
      showSaved(status === TASK_STATUS.COMPLETED ? '任务已完成' : '任务已重新打开');
      this.refresh();
    } catch (error) {
      showError(error);
    }
  },

  startTimerForTask(task) {
    if (task.timerMatchesTask) {
      wx.switchTab({ url: '/pages/timer/index' });
      return;
    }
    const candidates = task.planCandidates || [];
    if (candidates.length === 1) {
      this.startTimerForTaskCandidate(task.id, candidates[0].id);
      return;
    }
    if (!candidates.length) {
      wx.showToast({ title: '当前没有可执行的关联计划', icon: 'none' });
      return;
    }
    wx.showActionSheet({
      itemList: candidates.map((candidate) => candidate.title || '未命名计划'),
      success: (result) => {
        const candidate = candidates[result.tapIndex];
        if (candidate) this.startTimerForTaskCandidate(task.id, candidate.id);
      }
    });
  },

  startTimerForTaskCandidate(taskId, candidateId) {
    try {
      getService().startTaskPlanTimer(taskId, candidateId);
      wx.switchTab({ url: '/pages/timer/index' });
    } catch (error) {
      showError(error);
    }
  },

  toggleProjectTodoExpansion(event) {
    const id = event.currentTarget.dataset.id;
    this.setData({ expandedProjectIds: toggleId(this.data.expandedProjectIds, id) }, () => this.refresh());
  },

  toggleProjectCompletedExpansion(event) {
    const id = event.currentTarget.dataset.id;
    this.setData({ expandedCompletedProjectIds: toggleId(this.data.expandedCompletedProjectIds, id) }, () => this.refresh());
  },

  toggleProjectCollapse(event) {
    const id = event.currentTarget.dataset.id;
    const collapsedProjectIds = toggleId(this.data.collapsedProjectIds, id);
    let persisted = false;
    try {
      const profileId = localProfileId(getService().snapshot());
      this.preferenceProfileId = profileId;
      persisted = saveProjectCollapsedIds(getPreferenceStore(), profileId, collapsedProjectIds);
    } catch (error) {
      persisted = false;
    }
    this.setData({ collapsedProjectIds }, () => this.refresh());
    if (!persisted) wx.showToast({ title: '本次设置仅在当前会话生效', icon: 'none' });
  },

  clearProjectCollapseState(id) {
    const collapsedProjectIds = this.data.collapsedProjectIds.filter((projectId) => projectId !== id);
    if (collapsedProjectIds.length === this.data.collapsedProjectIds.length) return;
    try {
      const profileId = localProfileId(getService().snapshot());
      this.preferenceProfileId = profileId;
      saveProjectCollapsedIds(getPreferenceStore(), profileId, collapsedProjectIds);
    } catch (error) {
      // 项目操作已经成功，偏好收敛失败不能改判业务结果。
    }
    this.setData({ collapsedProjectIds });
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
    const task = this.data.tasks.find((item) => item.id === id);
    const hasPlanAssociations = Boolean(task && (task.entityPlanCount || task.repeatRuleCount));
    const content = hasPlanAssociations
      ? `该任务关联 ${task.entityPlanCount} 个实体计划和 ${task.repeatRuleCount} 个固定日程。确认后会删除任务、未结束实体计划及全部固定日程；已结束计划和时间记录会保留并解除关联。`
      : '未结束的关联计划会一并删除；已结束计划和计时记录会保留。';
    wx.showModal({
      title: '删除任务',
      content,
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
          this.clearProjectCollapseState(id);
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
          this.clearProjectCollapseState(id);
          showSaved('项目已放弃');
          this.refresh();
        } catch (error) {
          showError(error);
        }
      }
    });
  },

  toggleWishSection() {
    const isWishExpanded = !this.data.isWishExpanded;
    this.setData({ isWishExpanded }, () => {
      if (isWishExpanded && this.data.wishListColumns.length) this.measureWishColumn();
    });
  },

  addWish() {
    try {
      getService().createWish(this.data.wishTitle);
      this.setData({ wishTitle: '' });
      showSaved('愿望已添加');
      this.refresh({ focusLatestWish: true });
    } catch (error) {
      showError(error);
    }
  },

  convertWish(event) {
    const id = event.currentTarget.dataset.id;
    const service = getService();
    try {
      service.validateWishToProject(id);
    } catch (error) {
      showError(error);
      return;
    }
    wx.showModal({
      title: '转为项目',
      content: '转换后将创建同名项目，并从愿望池移除该愿望。',
      confirmText: '转为项目',
      success: (result) => {
        if (!result.confirm) return;
        try {
          service.convertWishToProject(id);
          showSaved('愿望已转为项目');
          this.refresh();
        } catch (error) {
          showError(error);
        }
      }
    });
  },

  openWishTitleEditor(event) {
    const wish = this.data.wishes.find((item) => item.id === event.currentTarget.dataset.id);
    if (!wish) return;
    this.setData({ wishTitleEditId: wish.id, wishTitleEditValue: wish.title });
  },

  onWishTitleInput(event) {
    this.setData({ wishTitleEditValue: limitTitleCodePoints(event.detail.value) });
  },

  saveWishTitle(event) {
    const wishId = this.data.wishTitleEditId;
    if (!wishId) return;
    const wish = this.data.wishes.find((item) => item.id === wishId);
    if (!wish) {
      this.setData({ wishTitleEditId: '', wishTitleEditValue: '' });
      return;
    }
    const title = limitTitleCodePoints(event && event.detail ? event.detail.value : this.data.wishTitleEditValue);
    if (title === wish.title) {
      this.setData({ wishTitleEditId: '', wishTitleEditValue: '' });
      return;
    }
    try {
      getService().updateWish(wishId, title);
      this.setData({ wishTitleEditId: '', wishTitleEditValue: '' });
      showSaved('愿望已更新');
      this.refresh();
    } catch (error) {
      showError(error);
    }
  },

  confirmDeleteWish(event) {
    const id = event.currentTarget.dataset.id;
    wx.showModal({
      title: '删除愿望',
      content: '删除后无法恢复。',
      confirmColor: '#9a5550',
      success: (result) => {
        if (!result.confirm) return;
        try {
          getService().deleteWish(id, true);
          showSaved('愿望已删除');
          this.refresh();
        } catch (error) {
          showError(error);
        }
      }
    });
  },

  onUnload() {
    this.clearNextLocalDayRefresh();
    this.clearTodoScrollAnimation();
    this.clearWishScrollAnimation();
  },

  onResize() {
    this.measureTodoColumn();
    if (this.data.isWishExpanded && this.data.wishListColumns.length) this.measureWishColumn();
    this.measureTodoTitleFontSizes();
    this.measureProjectDeadlineOverflow();
  },

  noop() {}
});
