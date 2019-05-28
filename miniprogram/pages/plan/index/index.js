// miniprogram/pages/plan/index/index.js

const tabNames = ["事务管理", "日程管理"],
  appData = getApp().globalData;

Page({

  data: {
    // 描述列表
    descriptions: [],
    description: "",
    // 标签列表
    dubbleTabs: [],
    // 事务管理列表
    subTabNames: [],
    lists: [],
    list: [],
    object: "日程",
    subObjId: null,
    // 弹出层
    showPopup: false,
    inputTag: false,
    evtTag: "紧急",
    evtName: "未命名事务",
    evtDesc: "",
    evtTabName: null,
    evtTabId: null,
  },


  ////////////////////////////////
  /// 新增事务
  ////////////////////////////////

  onAddTap(e) {
    console.log(e);
    this.setData({
      showPopup: true
    });
  },

  onBgTap() {
    this.setData({
      showPopup: false
    });
  },

  onConfirmTap() {
    var item = {
      name: this.data.evtName
    };
    if (this.data.evtDesc) {
      item["description"] = this.data.evtDesc;
    }
    if (this.data.inputTag) {
      item["tag"] = this.data.evtTag;
    }
    if (this.data.evtTabName == null) {
      wx.lin.showMessage({
        duration: 2500,
        type: 'error',
        content: '必须选择事件的类型！'
      });
    } else {
      this.addEvent(item, this.data.evtTabName);
      this.setData({
        showPopup: false
      });
    }
  },

  inputEvtTag(e) {
    let tag = e.detail.value;
    this.data.evtTag = tag;
  },

  inputEvtName(e) {
    let name = e.detail.detail.value;
    this.data.evtName = name;
  },

  inputEvtDesc(e) {
    let desc = e.detail.detail.value;
    this.data.evtDesc = desc;
  },

  switchChange(e) {
    let s = e.detail.value;
    this.setData({
      inputTag: s
    });
  },

  selectTab(e) {
    let id = e.detail.id,
      tabName = e.detail.value;
    this.data.evtTabId = id;
    this.data.evtTabName = tabName;
  },


  ///////////////////////////////
  /// 标签-列表
  ///////////////////////////////

  changeTabs(e) {
    // 修改description,list的内容
    if (e.detail.currentIndex == 1) {
      this.setData({
        description: e.detail.activeKey,
        object: "日程"
      });
    } else {
      let id = Number(e.detail.activeSubKey);
      this.setData({
        description: this.data.descriptions[id],
        list: this.data.lists[id],
        object: "事务",
        subObjId: id
      });
    }
  },

  // 根据appData.toDoLists
  // 给页面的 事务管理数据 赋值
  crtEventTabs() {
    var lists = appData.toDoLists,
      len = lists.length,
      descriptions = this.data.descriptions,
      size = descriptions.length,
      dubbleTabs = this.data.dubbleTabs,
      pageLists = this.data.lists,
      subTabNames = this.data.subTabNames;
    if (len > 0)
      for (var i = 0; i < len; i++) {
        let dubbleTab = {
          tab: tabNames[0],
          key: "事务管理",
          subKey: size.toString(),
          subTab: lists[i].name
        };
        dubbleTabs.push(dubbleTab);
        descriptions.push(lists[i].name + "：" + lists[i].description);
        pageLists.push(lists[i].lists);
        subTabNames.push({
          id: size,
          name: lists[i].name
        });
        size++;
      }
    this.setData({
      dubbleTabs: dubbleTabs,
      descriptions: descriptions,
      lists: pageLists,
      subTabNames: subTabNames
    });
  },

  // 给页面的 日程管理数据 赋值
  crtTimeTabs() {
    var dubbleTabs = this.data.dubbleTabs;
    dubbleTabs.push({
      tab: tabNames[1],
      key: "日程管理：从时间的维度，锁定重要的事情。"
    });
    this.setData({
      dubbleTabs: dubbleTabs
    });
  },

  // 新增事务
  addEvent(item, evtTabName) {
    var lists = this.data.lists,
      subTabNames = this.data.subTabNames,
      id = -1;
    // 查找item的tag对应的subTabNames中的下标
    for (var i = 0; i < subTabNames.length; i++) {
      if (subTabNames[i].name == evtTabName)
        id = i;
    }
    if (id === -1) return;

    if (this.data.subObjId == id) {
      // 赋值list
      let list = this.data.list;
      list.push(item);
      this.setData({
        list: list
      });
    } else {
      // 赋值lists
      lists[id].push(item);
      this.setData({
        lists: lists
      });
    }
  },

  onLoad(options) {
    this.crtEventTabs();
    this.crtTimeTabs();
    this.changeTabs({
      detail: {
        activeKey: 0,
        activeSubKey: 0
      }
    });
  },

})