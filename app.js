App({
  onLaunch() {
    wx.cloud.init({ env: 'cloud1-0g9ypxoqbc4fb323', traceUser: true })
  },
  globalData: {
    // ★ 修改为真实宿舍成员姓名
    roommates: ['唐诚俊', '黄炜廉', '张世奕', '郭银海'],
  },
})
