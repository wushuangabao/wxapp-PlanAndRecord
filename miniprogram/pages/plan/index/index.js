// miniprogram/pages/plan/index/index.js

// TODO: 
// 将数据保存到云端数据库
// 自定义事务的标签

const tabNames = ["事务管理", "日程管理", "项目管理"],
  appData = getApp().globalData,
  AV = getApp().AV,
  convertEvtTab = data => ({
    name: data.get('name'),
    id: data.get('id'),
    description: data.get('description')
  }),
  convertEvtItem = data => ({
    name: data.get('name'),
    tab: data.get('tab'),
    description: data.get('description'),
    tag: data.get('tag'),
    ddl: data.get('ddl')
  });

Page({
  data: {
    // 屏幕高度
    height: 1400,
    // 描述列表
    evtDescriptions: [],
    description: "",
    // 标签列表
    dubbleTabs: [],
    object: "事务", //当前主标签
    subObjId: null, //当前子标签id
    // 事务管理列表
    evtTabNames: [],
    lists: [],
    list: [],
    // 弹出层
    showPopup: false,
    inputTag: false,
    evtTag: "紧急",
    evtName: "",
    evtDesc: "",
    evtTabName: null,
    evtTabId: null,
    // 当前正修改的事务 在list中的下标
    currentItem: -1,
  },


  ////////////////////////////////
  /// 弹出层
  ////////////////////////////////

  // 点击新增按钮
  onAddTap(e) {
    let evtTabId = this.data.subObjId,
      evtTabName = this.data.evtTabNames[evtTabId];
    this.setData({
      inputTag: false,
      evtName: "",
      evtDesc: "",
      evtTabName: evtTabName,
      evtTabId: evtTabId,
      showPopup: true,
      currentItem: -1
    });
  },

  onBgTap() {
    this.setData({
      showPopup: false
    });
  },

  // 点击删除按钮
  onDeleteTap() {
    this.deleteEvent();
    this.setData({
      showPopup: false
    });
  },

  // 点击确认按钮
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
    if (this.data.evtName == "") {
      wx.lin.showMessage({
        duration: 2000,
        type: 'error',
        content: '必须填写事务的名称！'
      });
    } else {
      if (this.data.currentItem != -1) {
        // 修改事务
        this.deleteEvent();
        this.addEvent(item, this.data.evtTabName);
      } else {
        // 新增事务
        this.addEvent(item);
      }
      this.setData({
        showPopup: false
      });
    }
  },

  ////////////////////////
  /// 表单操作
  ////////////////////////

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

  ////////////////////////////////
  /// 点击某项事务（进而删、改）
  ////////////////////////////////
  onItemTap(e) {
    let id = Number(e.currentTarget.id),
      item = this.data.list[id],
      subObjId = this.data.subObjId,
      subObj = this.data.evtTabNames[subObjId],
      evtData = {
        inputTag: false,
        evtTag: "紧急",
        evtName: item.name,
        evtDesc: "",
        evtTabName: subObj,
        evtTabId: subObjId,
        showPopup: true,
        currentItem: id
      };
    if (item.tag) {
      evtData.tag = item.tag;
      evtData.inputTag = true;
    }
    if (item.description) {
      evtData.evtDesc = item.description;
    }
    this.setData(evtData);
  },

  ///////////////////////////////
  /// 改变标签
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
        description: this.data.evtDescriptions[id],
        list: this.data.lists[id],
        object: "事务",
        subObjId: id
      });
    }
  },

  ///////////////////////
  /// 新增事务
  ///////////////////////
  addEvent(item, evtTabName) {
    var lists = this.data.lists,
      id = -1;
    if (arguments.length > 1) {
      let evtTabNames = this.data.evtTabNames;
      // 查找item对应的evtTabNames中的下标
      for (var i = 0; i < evtTabNames.length; i++) {
        if (evtTabNames[i] == evtTabName)
          id = i;
      }
      if (id === -1) return;
    } else {
      id = this.data.evtTabId;
    }
    lists[id].push(item);
    this.setData({
      lists: lists,
      dubbleTabs: this.data.dubbleTabs //必须重新赋值，否则内容不会刷新
    });
    this.setHeight();
  },

  //////////////////////
  /// 删除事务
  //////////////////////
  deleteEvent() {
    let list = this.data.list;
    list.splice(this.data.currentItem, 1);
    this.setData({
      list: list,
      dubbleTabs: this.data.dubbleTabs //必须重新赋值，否则内容不会刷新
    });
    this.setHeight();

  },

  ///////////////////////
  /// 页面初始化1
  ///////////////////////
  onLoad(options) {
    let planData = wx.getStorageSync('planData');
    if (planData) {
      console.log("直接使用缓存中的planData...");
      this.setData(planData);
      this.changeTabs({
        detail: {
          activeKey: 0,
          activeSubKey: 0
        }
      });
    } else {
      // 获取屏幕高度(rpx)
      let that = this;
      wx.getSystemInfo({
        success: function(res) {
          let clientHeight = res.windowHeight;
          let clientWidth = res.windowWidth;
          let ratio = 750 / clientWidth;
          let height = clientHeight * ratio;
          that.setData({
            vHeight: height - 300
          });
        }
      });
      this.setHeight();
    }
    this.openid = wx.getStorageSync('openid');
  },

  ///////////////////////
  /// 页面初始化2
  ///////////////////////
  onReady() {
    this.componentTabs = this.selectComponent('#tabs');
    // this.crtEventData();
    // this.crtTimeTabs();
    // 上面两个方法是使用云开发。
    // 现替换为下面的，使用leanCloud数据库：
    if (this.data.dubbleTabs.length == 0) {
      new AV.Query('EvtTabs')
        .find()
        .then(tabs => {
          var data = tabs.map(convertEvtTab);
          // 创建事务标签
          this.crtEvtTabs(data);
          var query = new AV.Query('EvtItems');
          query.equalTo('openid', this.openid);
          query.find()
            .then(items => {
              var data = items.map(convertEvtItem);
              // 创建事务内容（todolist）
              this.crtEvtLists(data);
              // 创建日程标签 TODO
              this.crtTimeTabs();
              // 刷新标签（重新渲染）
              this.resetTabs();
              console.log("已完成plan数据的下载！");
            })
            .catch(console.error);
        })
        .catch(console.error);
    }
  },

  /////////////////////////
  /// 创建 事务管理 内容
  /////////////////////////
  crtEvtLists(data) {
    var sizeEvtTabs = this.data.sizeEvtTabs,
      lists = new Array(sizeEvtTabs),
      len = data.length;
    for (var i = 0; i < sizeEvtTabs; i++) {
      lists[i] = [];
    }
    if (len > 0) {
      for (var i = 0; i < len; i++) {
        var tabId = data[i].tab;
        if (tabId >= 0 && tabId < this.data.sizeEvtTabs) {
          let item = {
            name: data[i].name
          };
          if (data[i].description) {
            item['description'] = data[i].description;
          }
          if (data[i].tag) {
            item['tag'] = data[i].tag;
          }
          lists[tabId].push(item);
        }
      }
      this.setData({
        lists: lists
      });
    }
  },

  /////////////////////////
  /// 创建 事务管理 标签
  /////////////////////////
  crtEvtTabs(data) {
    var evtTabNames = [],
      descriptions = [],
      dubbleTabs = [],
      len = data.length;
    if (len > 0) {
      for (var i = 0; i < len; i++) {
        let dubbleTab = {
          tab: tabNames[0],
          key: "事务管理",
          subKey: data[i].id.toString(), //如果不转化为字符串，subKey==0这项会无法显示
          subTab: data[i].name
        };
        dubbleTabs.push(dubbleTab);
        descriptions.push(data[i].name + "：" + data[i].description);
        evtTabNames.push(data[i].name);
      }
      this.setData({
        dubbleTabs: dubbleTabs,
        evtDescriptions: descriptions,
        evtTabNames: evtTabNames,
        sizeEvtTabs: len
      });
    }
  },

  ////////////////////////
  /// 刷新标签（重新渲染）
  ////////////////////////
  resetTabs() {
    // 初始化当前被选中的标签
    this.changeTabs({
      detail: {
        activeKey: 0,
        activeSubKey: 0
      }
    });
    // 调用自定义组件tabs的方法
    this.componentTabs.initTabs();
  },

  //////////////////////////////
  /// 创建 日程管理 标签
  //////////////////////////////
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

  /////////////////////
  /// 设置tabs的高度
  /////////////////////
  setHeight() {
    let maxSize = 0,
      height = 480,
      lists = this.data.lists;
    for (var i = 0; i < lists.length; i++) {
      if (lists[i].length > maxSize)
        maxSize = lists[i].length;
    }
    if (maxSize > 5) {
      height = 88 * maxSize;
      // 超出屏幕，提示事务太多
      if (height > this.data.vHeight) {
        //不做限制height = this.data.vHeight;
        wx.lin.showMessage({
          duration: 2500,
          type: 'warning',
          content: '事情太多了，考虑扔掉一些吧！'
        });
      }
    }
    this.setData({
      height: height
    });
  },


  ////////////////////
  /// 离开页面
  ////////////////////
  onHide() {
    console.log("onHide");
    wx.setStorageSync('planData', this.data);
  },

  //////////////////////////////
  /// 根据appData.toDoLists
  /// 给页面的 事务管理数据 赋值
  ///
  /// **弃用**
  //////////////////////////////
  crtEventData() {
    let openid = wx.getStorageSync("openid");
    // 查询当前用户的toDoList
    wx.cloud.database().collection('toDoList').where({
      _openid: openid
    }).get({
      success: res => {
        this.setEvtData(res.data);
        this.resetTabs();
      },
      fail: err => {
        this.showQryError(err);
      }
    });
  },

  // 查询失败的提示
  // **弃用**
  showQryError(err) {
    wx.lin.showMessage({
      duration: 2000,
      type: 'error',
      content: '数据库查询失败！'
    });
    console.error('[数据库] [查询记录] 失败：', err);
  },

  // 设置事务分类、描述、todolists
  // **弃用**
  setEvtData(data) {
    console.log('[数据库] [查询toDoList] 成功: ', data);
    var evtTabNames = [],
      descriptions = [],
      dubbleTabs = [],
      lists = [],
      len = data.length;
    if (len > 0) {
      for (var i = 0; i < len; i++) {
        let dubbleTab = {
          tab: tabNames[0],
          key: "事务管理",
          subKey: data[i].id,
          subTab: data[i].name
        };
        dubbleTabs.push(dubbleTab);
        descriptions.push(data[i].name + "：" + data[i].description);
        evtTabNames.push(data[i].name);
        lists.push(data[i].list);
      }
      this.setData({
        dubbleTabs: dubbleTabs,
        evtDescriptions: descriptions,
        evtTabNames: evtTabNames,
        lists: lists,
        sizeEvt: len
      });
    }
  }
})