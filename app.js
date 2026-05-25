App({
  onLaunch() {
    wx.cloud.init({ env: 'YOUR_ENV_ID', traceUser: true })// ★ 填入真实云开发环境ID
  },
  globalData: {
    // ★ 修改为真实宿舍成员姓名
    roommates: ['张三', '李四', '王五', '赵六'],
  },
})
