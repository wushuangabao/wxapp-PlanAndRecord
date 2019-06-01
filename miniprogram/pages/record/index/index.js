// miniprogram/pages/record/index/index.js
Page({

  data: {
    // 日期
    year: "",
    month: "",
    day: "",
    date: "", //选择的日期
    today: "", //当天的日期
    // 弹出层
    showPopup: false,
    content: "",
    long: 0, //以min为单位
    tagTimeId: 0,
    tagEvtId: [0],
    // 记录列表
    list: [{
        content: "一条记录",
        long: 65,
        fLong: "1h 5min",
        tagTime: "深度工作",
        tagEvt: ["输入", "音频", "听得到"]
      },
      {
        content: "一条记录",
        long: 10,
        fLong: "10min",
        tagTime: "深度工作",
        tagEvt: ["输入", "音频", "听得到"]
      }
    ],
    currentItem: -1,
  },

  /////////////////////
  /// 点击，选择日期
  /////////////////////
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

  /////////////////////
  /// 点击，新增记录
  /////////////////////
  onAddTap(e) {
    this.data.tagTimeId = e.detail.index;
    this.setData({
      showPopup: true,
    });
  },

  /////////////////////
  /// 向前翻页
  /////////////////////
  onPagePreTap() {
    let year = Number(this.data.year),
      month = Number(this.data.month),
      day = Number(this.data.day),
      arrDate = this.getPreDate(year, month, day);
    if (arrDate) {
      // 设置日期
      setTimeout(() => {
        this.setDate(arrDate[0], arrDate[1], arrDate[2]);
      }, this.timeAnim-100);
      // 输出动画
      this.setData({
        animation: this.animRight
      });
    }
  },

  /////////////////////
  /// 向后翻页
  /////////////////////
  onPageNextTap() {
    let year = Number(this.data.year),
      month = Number(this.data.month),
      day = Number(this.data.day),
      arrDate = this.getNextDate(year, month, day);
    if (arrDate) {
      // 设置日期
      setTimeout(() => {
        this.setDate(arrDate[0], arrDate[1], arrDate[2]);
      }, this.timeAnim-100);
      // 输出动画
      this.setData({
        animation: this.animLeft
      });
    }
  },

  //////////////////////
  /// 页面隐藏
  //////////////////////
  onHide() {
    if (this.data.date === this.data.today)
      wx.setStorageSync("record", this.data.list);
  },

  //////////////////////
  /// 页面初始化
  //////////////////////
  onLoad: function(options) {
    // 初始化动画效果
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
    // 初始化记录列表
    let record = wx.getStorageSync("record");
    if (record) {
      this.setData({
        list: record
      });
    } else {
      // todo:从leancloud查询
    }
    // 获取屏幕高度(rpx)
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
    // 初始化日期和标签
    let globalData = getApp().globalData,
      date = this.getNowFormatDate();
    this.setData({
      tagsTime: globalData.timeTag,
      tagsEvent: globalData.eventTag,
      today: date
    });
    this.selectDate({
      detail: {
        value: date
      }
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