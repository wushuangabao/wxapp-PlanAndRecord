//app.js

App({
  onLaunch: function() {

    const AV = require('./libs/av-weapp-min.js');
    AV.init({
      appId: '3omW7gdCWWamp76jwi8PgTxI-gzGzoHsz',
      appKey: 'YYlvzYUQ6FvwQ4sWiTOtnCSo',
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
        {
          name: "浮浅工作",
          desc: "不需要专注，用于简单任务的大段时间"
        },
        {
          name: "碎片时间",
          desc: "工作之外的，小段的碎片化时间"
        },
        {
          name: "专用时间",
          desc: "需要专注，工作之外花在某事上的时间"
        },
        {
          name: "深度工作",
          desc: "保持专注的，大段的深度工作时间"
        },
      ],

      // 事件标签（最大层数3）
      eventTag: [{
          name: "输入",
          desc: "让大脑变成海绵，接收新的刺激",
          list: [{
              name: "阅读",
              list: [{
                  name: "微信号"
                },
                {
                  name: "专业书"
                }, {
                  name: "小说"
                }, {
                  name: "其他书"
                }
              ]
            },
            {
              name: "视频",
              list: [{
                  name: "学视频"
                },
                {
                  name: "影剧漫",
                }
              ]
            },
            {
              name: "音频",
              list: [{
                name: "听得到"
              }]
            }
          ]
        },
        {
          name: "输出",
          desc: "就结果而言，产出了自己的作品",
          list: [{
              name: "写作",
              list: [{
                  name: "写自媒体"
                },
                {
                  name: "写笔记",
                }
              ]
            },
            {
              name: "编程",
              list: [{
                  name: "做应用"
                },
                {
                  name: "做游戏",
                }
              ]
            },
            {
              name: "画画"
            }
          ]
        },
        {
          name: "休闲",
          desc: "大脑处于较放松的状态",
          list: [{
              name: "运动",
              list: [{
                  name: "健身运动"
                },
                {
                  name: "其他运动",
                }
              ]
            },
            {
              name: "社交",
              list: [{
                  name: "网络社交"
                },
                {
                  name: "真实社交",
                }
              ]
            },
            {
              name: "玩游戏"
            }
          ]
        }
      ]

    }
  }
})