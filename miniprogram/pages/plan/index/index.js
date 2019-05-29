// miniprogram/pages/plan/index/index.js

const tabNames = ["事务管理", "日程管理"],
  appData = getApp().globalData,
  AV = getApp().AV,
  getDataForRender = data => ({
    name: data.get('name'),
    id: data.get('id')
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
    object: "事务",
    subObjId: null,
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
    currentItem: -1, //表示当前没有在修改某事务
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
        this.deleteEvent();
      }
      this.addEvent(item, this.data.evtTabName);
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
      subObj = this.data.evtTabNames[subObjId].name,
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

  //////////////////////////////
  /// 根据appData.toDoLists
  /// 给页面的 事务管理数据 赋值
  //////////////////////////////
  crtEventData() {
    let openid = wx.getStorageSync("openid");
    // 查询当前用户的toDoList
    wx.cloud.database().collection('toDoList').where({
      _openid: openid
    }).get({
      success: res => {
        this.setEvtData(res.data);
        // 调用自定义组件tabs的方法
        this.componentTabs.initTabs();
        this.changeTabs({
          detail: {
            activeKey: 0,
            activeSubKey: 0
          }
        });
      },
      fail: err => {
        this.showQryError(err);
      }
    });
  },

  // 查询失败的提示
  showQryError(err) {
    wx.lin.showMessage({
      duration: 2000,
      type: 'error',
      content: '数据库查询失败！'
    });
    console.error('[数据库] [查询记录] 失败：', err);
  },

  // 设置事务分类、描述、todolists
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
  },

  //////////////////////////////
  /// 给页面的 日程管理数据 赋值
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

  ///////////////////////
  /// 新增事务
  ///////////////////////
  addEvent(item, evtTabName) {
    var lists = this.data.lists,
      evtTabNames = this.data.evtTabNames,
      id = -1;
    // 查找item的tag对应的evtTabNames中的下标
    for (var i = 0; i < evtTabNames.length; i++) {
      if (evtTabNames[i] == evtTabName)
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

    this.setHeight();
  },

  //////////////////////
  /// 删除事务
  //////////////////////
  deleteEvent() {
    let list = this.data.list;
    list.splice(this.data.currentItem, 1);
    this.setData({
      list: list
    });
    this.setHeight();
  },

  ///////////////////////
  /// 页面初始化
  ///////////////////////
  onLoad(options) {
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
  },

  onReady() {
    this.componentTabs = this.selectComponent('#tabs');
    this.crtEventData();
    // this.crtTimeTabs();


    new AV.Query('EvtTabs')
      .find()
      .then(todos => {
        var data = todos.map(getDataForRender)
        console.log(data)
      })
      .catch(console.error);

  },

  /////////////////////
  /// 设置tabs的高度
  /////////////////////
  setHeight() {
    let maxSize = 0,
      height = 352,
      lists = this.data.lists;
    for (var i = 0; i < lists.length; i++) {
      if (lists[i].length > maxSize)
        maxSize = lists[i].length;
    }
    if (maxSize > 4) {
      height = 88 * maxSize;
      // 超出屏幕的部分不可见，防止事务太多
      if (height > this.data.vHeight) {
        height = this.data.vHeight;
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

})