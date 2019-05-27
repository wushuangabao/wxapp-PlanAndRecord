// miniprogram/pages/plan/index/index.js

const tabNames = ["事务管理", "日程管理"],
  appData = getApp().globalData;

Page({

  data: {
    // 描述列表
    descriptions: [],
    description: "日程管理：从时间的维度，锁定重要的事情。",
    // 标签列表
    dubbleTabs: [{
      tab: tabNames[1],
      key: "日程管理：从时间的维度，锁定重要的事情。"
    }],
    // 事务管理列表
    subTabNames:[],
    lists: [],
    list: [{
        name: "item1",
        description: "description",
        tag: "important"
      },
      {
        name: "item2"
      }
    ],
    // 弹出层
    showPopup:false,
  },

  ////////////////////////////////
  /// 新增事务
  ////////////////////////////////

  onAddTap(e){
    console.log(e);
    this.setData({
      showPopup:true
    });
  },

  onBgTap(){
    this.setData({
      showPopup: false
    });
  },

  onConfirmTap(){
    // todo
    this.setData({
      showPopup: false
    });
  },

  ///////////////////////////////
  /// 标签-列表
  ///////////////////////////////
  
  changeTabs(e) {
    // 修改description,list的内容
    if (e.detail.currentIndex == 0)
      this.setData({
        description: e.detail.activeKey
      });
    else {
      let id = Number(e.detail.activeSubKey);
      this.setData({
        description: this.data.descriptions[id],
        list: this.data.lists[id]
      });
    }
  },

  // 根据appData.toDoLists给页面数据赋值
  createDubbleTabs() {
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
          id:size,
          name:lists[i].name
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

  onLoad(options) {
    this.createDubbleTabs();
  },

})