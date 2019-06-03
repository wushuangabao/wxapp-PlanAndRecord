// miniprogram/pages/record/index/index.js

// 不同类别的事件标签的标识（颜色）
const EvtColors = ["rgb(235,103,204)", "rgb(29,114,200)", "rgb(114,0,255)"];

Page({

  data: {
    // 事件标签选择的MultiPicker-------
    multiArray: [
      ['输入', '输出'],
      ['阅读', '视频', '音频'],
      ['微信号', '专业书', '小说', '其他书']
    ],
    multiIndex: [0, 0, 0],
    // 时间标签选择的ActionSheet-------
    showTimeSheet: false,
    // 日期---------------------------
    year: "",
    month: "",
    day: "",
    date: "", //选择的日期
    today: "", //当天的日期
    // 弹出层------------------------
    showPopup: false,
    record: "",
    min: 0,
    hour: 0,
    tagTimeId: 0,
    tagEvt: [],
    // 记录列表-----------------------
    list: [{
        content: "一条记录最多能写几个字三四五六",
        long: 65,
        fLong: "1h 5min",
        tagTimeId: 0,
        tagEvt: ["输入", "音频", "听得到"]
      },
      {
        content: "一条记录",
        long: 10,
        fLong: "10min",
        tagTimeId: 1,
        tagEvt: ["输出", "编程", "做应用"]
      },
      {
        content: "一条记录",
        long: 10,
        fLong: "10min",
        tagTimeId: 2,
        tagEvt: ["输出", "画画"]
      },
      {
        content: "一条记录",
        long: 10,
        fLong: "10min",
        tagTimeId: 3,
        tagEvt: ["休闲", "运动", "健身运动"]
      }
    ],
  },


  /////////////////////////////////////////
  ///
  /// 操作反馈
  ///
  /////////////////////////////////////////

  bindMultiPickerChange: function(e) {
    let arrId = e.detail.value,
      arrEvt = thia.data.multiArray,
      len = arrEvt.length,
      tagEvt = [];
    for (var i = 0; i < len; i++) {
      tagEvt.push(arrEvt[i][arrId[i]]);
    }
    this.setData({
      tagEvt: tagEvt
    });
  },

  bindMultiPickerColumnChange: function(e) {
    var data = {
      multiArray: this.data.multiArray,
      multiIndex: this.data.multiIndex
    };
    data.multiIndex[e.detail.column] = e.detail.value;
    switch (e.detail.column) {
      // 修改第1列
      case 0:
        switch (data.multiIndex[0]) {
          // 改为第1类
          case 0:
            data.multiArray[1] = ['扁性动物', '线形动物', '环节动物', '软体动物', '节肢动物'];
            data.multiArray[2] = ['猪肉绦虫', '吸血虫'];
            break;
            // 改为第2类
          case 1:
            data.multiArray[1] = ['鱼', '两栖动物', '爬行动物'];
            data.multiArray[2] = ['鲫鱼', '带鱼'];
            break;
        }
        data.multiIndex[1] = 0;
        data.multiIndex[2] = 0;
        break;
        // 修改第2列
      case 1:
        switch (data.multiIndex[0]) {
          // 改为第1类中的...
          case 0:
            switch (data.multiIndex[1]) {
              // 改为第1类中的第1类
              case 0:
                data.multiArray[2] = ['猪肉绦虫', '吸血虫'];
                break;
                // 改为第1类中的第2类
              case 1:
                data.multiArray[2] = ['蛔虫'];
                break;
              case 2:
                data.multiArray[2] = ['蚂蚁', '蚂蟥'];
                break;
              case 3:
                data.multiArray[2] = ['河蚌', '蜗牛', '蛞蝓'];
                break;
              case 4:
                data.multiArray[2] = ['昆虫', '甲壳动物', '蛛形动物', '多足动物'];
                break;
            }
            break;
            // 改为第1类中的...
          case 1:
            switch (data.multiIndex[1]) {
              case 0:
                data.multiArray[2] = ['鲫鱼', '带鱼'];
                break;
              case 1:
                data.multiArray[2] = ['青蛙', '娃娃鱼'];
                break;
              case 2:
                data.multiArray[2] = ['蜥蜴', '龟', '壁虎'];
                break;
            }
            break;
        }
        data.multiIndex[2] = 0;
        break;
    }
    console.log(data.multiIndex);
    this.setData(data);
  },

  // 选择一条记录
  onRecordTap(e) {
    this.tagType = "record";
    this.listId = Number(e.currentTarget.id);
    wx.lin.showActionSheet({
      itemList: [{
        name: "修改记录内容"
      }, {
        name: "修改时间标签"
      }, {
        name: "删除记录"
      }],
    });
  },

  // 选择时间标签
  onTimeTagTap(e) {
    this.listId = e.currentTarget.dataset.listid;
    this.startChangeTagTime();
  },

  // 开始修改时间标签
  startChangeTagTime() {
    this.tagType = "time";
    let tagsTime = this.data.tagsTime,
      sheetList = [],
      lenTags = tagsTime.length;
    for (var i = 0; i < lenTags; i++) {
      let item = {
        name: tagsTime[i].name
      };
      if (i == this.data.list[this.listId].tagTimeId)
        item.color = "rgb(24,104,233)";
      sheetList.push(item);
    }
    this.setData({
      showTimeSheet: true,
      timeSheetList: sheetList
    });
  },

  // 选择ActionSheet某项
  selectTag(e) {
    let id = e.detail.index;
    if (this.tagType == "time") {
      // 修改时间标签
      let list = this.data.list;
      list[this.listId].tagTimeId = id;
      this.setData({
        list: list
      });
    } else if (this.tagType == "record") {
      // 修改记录内容
      if (id == 0) {
        let listItem = this.data.list[this.listId];
        this.setHourAndMin(listItem.long);
        this.setData({
          tagTimeId: listItem.tagTimeId,
          record: listItem.content,
          tagEvt: listItem.tagEvt,
          showPopup: true,
        });
      }
      // 准备修改时间标签
      else if (id == 1) {
        this.startChangeTagTime();
      }
      // 删除记录
      else if (id == 2) {
        let list = this.data.list;
        list.splice(this.listId, 1);
        this.setData({
          list: list
        });
      }
    }
    // else if (this.tagType == "evt") {
    //   // 重新选择标签
    //   if(id==0){
    //   }
    //   // 创建新的标签
    //   else if(id==1){
    //   }
    // }
  },

  // 选择日期
  selectDate(e) {
    let strDate = e.detail.value,
      arrDate = strDate.split("-");
    this.setData({
      date: strDate,
      year: arrDate[0],
      month: arrDate[1],
      day: arrDate[2]
    });
  },

  // 新增记录
  onAddTap(e) {
    this.setData({
      tagTimeId: e.detail.index,
      showPopup: true,
    });
  },

  // 向前翻页
  onPagePreTap() {
    if (!this.canChangePage)
      return;
    let year = Number(this.data.year),
      month = Number(this.data.month),
      day = Number(this.data.day),
      arrDate = this.getPreDate(year, month, day);
    if (arrDate) {
      // 暂时禁止翻页
      this.canChangePage = false;
      setTimeout(() => {
        this.canChangePage = true;
      }, this.timeAnim + 100);
      // 设置日期
      setTimeout(() => {
        this.setDate(arrDate[0], arrDate[1], arrDate[2]);
      }, this.timeAnim - 100);
      // 输出动画
      this.setData({
        animation: this.animRight
      });
    }
  },

  // 向后翻页
  onPageNextTap() {
    if (!this.canChangePage)
      return;
    let year = Number(this.data.year),
      month = Number(this.data.month),
      day = Number(this.data.day),
      arrDate = this.getNextDate(year, month, day);
    if (arrDate) {
      // 暂时禁止翻页
      this.canChangePage = false;
      setTimeout(() => {
        this.canChangePage = true;
      }, this.timeAnim + 100);
      // 设置日期
      setTimeout(() => {
        this.setDate(arrDate[0], arrDate[1], arrDate[2]);
      }, this.timeAnim - 100);
      // 输出动画
      this.setData({
        animation: this.animLeft
      });
    }
  },

  inputRecord(e) {
    this.setData({
      record: e.detail.detail.value
    });
  },

  onHourChange(e) {
    this.setData({
      hour: e.detail.count
    });
  },

  onMinChange(e) {
    this.setData({
      min: e.detail.count
    });
  },

  onBgTap(e) {
    this.setData({
      showPopup: false
    });
  },

  // 选择事件标签
  // onEvtTagTap(e) {
  // console.log(e);
  // let sheetList = [{
  //   name: "重新选择标签"
  // }, {
  //   name: "创建新的标签"
  // }];
  // // let listId = e.currentTarget.dataset.listid,
  // //   evtId = e.currentTarget.id,
  // //   nameTags = list[listId].tagEvt,
  // //   nameTag = nameTags[evtId];
  // wx.lin.showActionSheet({
  //   itemList: sheetList,
  //   title: "事件标签操作"
  // });
  // //this.sheetList=sheetList;
  // this.tagType = "evt";
  // this.listId = e.currentTarget.dataset.listid;
  // },



  //////////////////////
  /// 页面隐藏
  //////////////////////
  onHide() {
    if (this.data.date === this.data.today)
      wx.setStorageSync("record", this.data.list);
  },



  ///////////////////////////////
  ///
  /// 页面初始化
  ///
  ///////////////////////////////

  onLoad: function(options) {
    // 初始化翻页动画效果
    this.initAnimation();
    // 设置屏幕高度(rpx)
    this.setVHeight();
    // 初始化标签
    this.initTags();
    // 初始化日期
    let date = this.getNowFormatDate();
    this.setData({
      today: date
    });
    this.selectDate({
      detail: {
        value: date
      }
    });
    // 初始化记录列表
    this.initRecordList();
  },

  initAnimation() {
    this.canChangePage = true,
      this.timeAnim = 200;
    this.animLeft = wx.createAnimation({
      timingFunction: "ease-in",
      duration: this.timeAnim
    });
    this.animLeft.translate(-280, 0).step();
    this.animLeft.translate(0, 0).step({
      duration: 1
    });
    this.animRight = wx.createAnimation({
      timingFunction: "ease-in",
      duration: this.timeAnim
    });
    this.animRight.translate(280, 0).step();
    this.animRight.translate(0, 0).step({
      duration: 1
    });
  },

  initTags() {
    let tagsEvent = getApp().globalData.eventTag,
      tagsTime = getApp().globalData.timeTag,
      tagsTimeOneChar = [],
      tagsTimeColor = [],
      tagsEvtColor = {};
    // 初始化时间标签渲染用到的数据
    let len = tagsTime.length,
      step = 0.4 / len;
    for (var i = 0; i < len; i++) {
      tagsTimeOneChar.push(tagsTime[i].name.slice(0, 1));
      let num = (0.6 + i * step).toString();
      tagsTimeColor.push("rgba(53,139,40," + num + ")");
    }
    // 初始化事件标签渲染用到的数据
    this.setEvtColor(tagsEvtColor, tagsEvent);
    // 数据绑定
    this.setData({
      tagsTime: tagsTime, //时间标签名称和描述
      tagsTimeOneChar: tagsTimeOneChar, //时间标签首字符
      tagsTimeColor: tagsTimeColor, //时间标签颜色
      tagsEvent: tagsEvent, //事件标签名称和描述
      tagsEvtColor: tagsEvtColor //事件标签颜色
    });
  },

  // 遍历tagsEvent字典，为事件标签赋EvtColors中的颜色，存储到tagsEvtColor字典中。
  // 每一类别的颜色相同，EvtColors的长度==类别的个数。
  setEvtColor(tagsEvtColor, tagsEvent, color) {
    let len = tagsEvent.length;
    for (var i = 0; i < len; i++) {
      let evtColor = color;
      if (!evtColor)
        evtColor = EvtColors[i];
      tagsEvtColor[tagsEvent[i].name] = evtColor;
      if (tagsEvent[i].list) {
        this.setEvtColor(tagsEvtColor, tagsEvent[i].list, evtColor);
      }
    }
  },

  // 初始化记录列表
  initRecordList() {
    let record = wx.getStorageSync("record");
    if (record) {
      this.setData({
        list: record
      });
    } else {
      // todo:从leancloud查询
    }
  },

  setVHeight() {
    let that = this;
    wx.getSystemInfo({
      success: function(res) {
        let clientHeight = res.windowHeight;
        let clientWidth = res.windowWidth;
        let ratio = 750 / clientWidth;
        let height = clientHeight * ratio;
        that.setData({
          vHeight: height
        });
      }
    });
  },

  /////////////////////////
  /// 找到事件标签数组
  /// 根据id数组
  /////////////////////////
  findEvts(arr) {
    return evts;
  },

  ////////////////////////
  /// 设置hour和min
  ////////////////////////
  setHourAndMin(l) {
    let h = Math.floor(l / 60),
      m = l - h * 60;
    this.setData({
      hour: h,
      min: m
    });
  },

  //////////////////////////
  /// 格式化时长
  /// 由分钟转为“xh ymin”
  //////////////////////////
  getFormatLong(long) {
    let h = Math.floor(long / 60),
      m = long - h,
      s = m + "min";
    if (h > 0)
      s = h + "h " + s;
    return s;
  },

  //////////////////////
  /// 设置日期数据
  //////////////////////
  setDate(year, month, day) {
    if (month >= 1 && month <= 9) {
      month = "0" + month;
    }
    if (day >= 0 && day <= 9) {
      day = "0" + day;
    }
    this.setData({
      date: year + "-" + month + "-" + day,
      year: year.toString(),
      month: month.toString(),
      day: day.toString()
    });
  },

  ///////////////////////
  /// 判断闰年
  ///////////////////////
  isLeapYear(year) {
    let cond1 = year % 4 == 0, //条件1：年份必须要能被4整除
      cond2 = year % 100 != 0, //条件2：年份不能是整百数
      cond3 = year % 400 == 0; //条件3：年份是400的倍数
    return cond1 && cond2 || cond3;
  },

  ////////////////////////
  /// 将日期往前推一天
  ////////////////////////
  getPreDate(year, month, day) {
    if (arguments.length != 3) {
      console.log("传入getPreDate的数据有误！");
      return false;
    }
    if (day == 1) {
      month--;
      if (month != 0) {
        switch (month) {
          case 1:
          case 3:
          case 5:
          case 7:
          case 8:
          case 9:
          case 11:
            day = 31;
            break;
          case 2:
            if (this.isLeapYear(year))
              day = 29;
            else
              day = 28;
            break;
          default:
            day = 30;
        }
      } else {
        year--;
        month = 12;
        day = 31;
      }
    } else {
      day--;
    }
    return [year, month, day];
  },

  ////////////////////////
  /// 将日期往后推一天
  /// 最迟推到today
  ////////////////////////
  getNextDate(year, month, day) {
    if (arguments.length != 3) {
      console.log("传入getPreDate的数据有误！");
      return false;
    }
    let arrToday = this.data.today.split("-");
    day++;
    // 检查是否超过了today
    if (day > arrToday[2] && month >= arrToday[1] && year >= arrToday[0]) {
      return false;
    }
    let mday = 30;
    switch (month) {
      case 1:
      case 3:
      case 5:
      case 7:
      case 8:
      case 9:
      case 11:
        mday = 31;
        break;
      case 2:
        if (this.isLeapYear(year))
          mday = 29;
        else
          mday = 28;
        break;
    }
    if (day > mday) {
      day = 1;
      month++;
      if (month > 12) {
        month = 1;
        year++;
      }
    }
    return [year, month, day];
  },

  ////////////////////////////////
  /// 获取日期，格式YYYY-MM-DD
  ////////////////////////////////
  getNowFormatDate() {
    var date = new Date();
    var seperator1 = "-";
    var year = date.getFullYear();
    var month = date.getMonth() + 1;
    var strDate = date.getDate();
    if (month >= 1 && month <= 9) {
      month = "0" + month;
    }
    if (strDate >= 0 && strDate <= 9) {
      strDate = "0" + strDate;
    }
    return year + seperator1 + month + seperator1 + strDate;
  }
})