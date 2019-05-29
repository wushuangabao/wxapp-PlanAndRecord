//app.js

App({
  onLaunch: function() {

    const AV = require('./libs/av-weapp-min.js');
    AV.init({
      appId: '4PIIJybk0I1qelR97Peq3vCd-gzGzoHsz',
      appKey: 'r89pv7xbJUOdWT52UpuMSKjT',
    });
    this.AV = AV;

    if (!wx.cloud) {
      console.error('请使用 2.2.3 或以上的基础库以使用云能力')
    } else {
      wx.cloud.init({
        traceUser: true,
      })
    }

    this.globalData = {

      //////////////////////////////
      /// 记录
      //////////////////////////////

      // 时间标签
      timeTag: [
        "深度",
        "浮浅"
      ],

      // 1级事件标签
      eventTag1: [
        "输入",
        "输出",
        "运动",
        "社交",
        "休闲"
      ],

      // 2级事件标签
      eventTag2: [
        // 输入
        [
          "阅读",
          "视频",
          "音频"
        ],
        // 输出
        [
          "写作",
          "编程",
          "画画"
        ],
        // 运动
        [
          "高强度",
          "低强度"
        ],
        // 社交
        [
          "线上",
          "线下"
        ],
        // 休闲
        [
          "阅读",
          "影视",
          "动漫"
        ],
      ],

      // // 事务管理
      // toDoLists: [{
      //     name: "备忘",
      //     description: "简单任务，容易遗忘掉",
      //     list: [
      //       {
      //       name:"一件事情",
      //       description:"具体描述，可以不写",
      //       tag:"紧急"
      //       },
      //       {
      //         name: "一件事情",
      //         description: "具体描述，可以不写",
      //       }
      //     ]
      //   },

    }
  }
})