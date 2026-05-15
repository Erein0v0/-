const app = getApp()
const DB = () => wx.cloud.database()

Page({
  data: {
    today: '', todayKey: '',
    roommates: [], selectedName: '', selectedIndex: 0,
    absentHours: 0, submitting: false, recentList: [],
    // 区间统计
    rangeStart: '', rangeEnd: '',
    queryingRange: false, rangeResult: null,
    rangeQueried: false, rangeResultLabel: '',
  },

  onLoad: function() {
    var d = new Date()
    var todayKey = d.getFullYear() + '/' + (d.getMonth()+1) + '/' + d.getDate()
    var todayDisplay = d.getFullYear() + '年' + (d.getMonth()+1) + '月' + d.getDate() + '日'
    this.setData({ today: todayDisplay, todayKey: todayKey, roommates: app.globalData.roommates })
    this._loadTodayRecords()
  },

  onShow: function() { this._loadTodayRecords() },

  _loadTodayRecords: function() {
    var self = this
    DB().collection('daily_bills').where({ date: self.data.todayKey }).get({
      success: function(res) { self.setData({ recentList: res.data }) },
      fail: function(err) { console.error('[loadTodayRecords]', err) },
    })
  },

  onPickerChange: function(e) {
    var idx = parseInt(e.detail.value)
    this.setData({ selectedIndex: idx, selectedName: this.data.roommates[idx] })
  },

  onSliderChange: function(e) {
    this.setData({ absentHours: parseFloat(e.detail.value !== undefined ? e.detail.value : e.detail) || 0 })
  },

  submitRecord: function() {
    var self = this
    if (!self.data.selectedName) { wx.showToast({ title: '请先选择舍友', icon: 'none' }); return }
    if (self.data.submitting) return
    self.setData({ submitting: true })
    wx.showLoading({ title: '记录中…' })

    var db = DB()
    var todayKey  = self.data.todayKey
    var name      = self.data.selectedName
    var absent    = self.data.absentHours
    var yearMonth = todayKey.split('/').slice(0, 2).join('/')

    // 查询是否已有该人今日记录（存在则更新，否则新建）
    db.collection('daily_bills').where({ date: todayKey, name: name }).get({
      success: function(res) {
        var op
        if (res.data.length > 0) {
          op = db.collection('daily_bills').doc(res.data[0]._id)
                 .update({ data: { absentHours: absent, cost: 0, yearMonth: yearMonth } })
        } else {
          op = db.collection('daily_bills').add({
            data: { name: name, date: todayKey, yearMonth: yearMonth,
                    absentHours: absent, cost: 0, createTime: db.serverDate() }
          })
        }
        op.then(function() {
          wx.hideLoading()
          wx.showToast({ title: '记账成功 ✓', icon: 'success' })
          self.setData({ submitting: false })
          self._loadTodayRecords()
        }).catch(function(err) {
          wx.hideLoading()
          wx.showToast({ title: '记账失败', icon: 'error' })
          self.setData({ submitting: false })
          console.error('[submitRecord]', err)
        })
      },
      fail: function(err) {
        wx.hideLoading()
        self.setData({ submitting: false })
        console.error('[submitRecord query]', err)
      }
    })
  },

  onRangeStartChange: function(e) {
    var v = e.detail.value  // "2026-05-01"
    // 转为 "2026/5/1"
    var parts = v.split('-')
    var s = parseInt(parts[0]) + '/' + parseInt(parts[1]) + '/' + parseInt(parts[2])
    this.setData({ rangeStart: s, rangeResult: null, rangeQueried: false })
  },

  onRangeEndChange: function(e) {
    var v = e.detail.value
    var parts = v.split('-')
    var s = parseInt(parts[0]) + '/' + parseInt(parts[1]) + '/' + parseInt(parts[2])
    this.setData({ rangeEnd: s, rangeResult: null, rangeQueried: false })
  },

  queryRange: function() {
    var self   = this
    var start  = self.data.rangeStart
    var end    = self.data.rangeEnd
    if (!start || !end) { wx.showToast({ title: '请选择日期范围', icon: 'none' }); return }
    function dk(s) {
      var p = s.split('/'); return parseInt(p[0])*10000 + parseInt(p[1])*100 + parseInt(p[2])
    }
    if (dk(start) > dk(end)) { wx.showToast({ title: '开始日期不能晚于结束日期', icon: 'none' }); return }
    if (self.data.queryingRange) return
    self.setData({ queryingRange: true, rangeResult: null, rangeQueried: false })
    wx.showLoading({ title: '查询中…' })

    var allRows = []
    function fetchBatch(skip) {
      wx.cloud.database().collection('daily_bills').skip(skip).limit(20).get({
        success: function(res) {
          allRows = allRows.concat(res.data)
          if (res.data.length === 20) { fetchBatch(skip + 20) }
          else { process(allRows) }
        },
        fail: function(err) { console.error('[queryRange]', err); process(allRows) },
      })
    }

    function process(data) {
      wx.hideLoading()
      var startK = dk(start), endK = dk(end)
      var best = {}
      for (var i = 0; i < data.length; i++) {
        var r = data[i]
        if (!r.cost || r.cost <= 0 || !r.date) continue
        if (dk(r.date) < startK || dk(r.date) > endK) continue
        var key = r.name + '|' + r.date
        if (!best[key] || r.cost > best[key].cost) best[key] = r
      }
      var keys = Object.keys(best)
      if (keys.length === 0) {
        self.setData({ queryingRange: false, rangeResult: null, rangeQueried: true }); return
      }
      var totalCost = 0, days = {}, kwhDays = {}, totalKwh = 0, persons = {}
      for (var bi = 0; bi < keys.length; bi++) {
        var rec = best[keys[bi]]
        totalCost += rec.cost
        days[rec.date] = true
        if (rec.kWh > 0 && !kwhDays[rec.date]) { kwhDays[rec.date] = rec.kWh; totalKwh += rec.kWh }
        if (!persons[rec.name]) persons[rec.name] = { cost: 0, kwh: 0 }
        persons[rec.name].cost = parseFloat((persons[rec.name].cost + rec.cost).toFixed(2))
        persons[rec.name].kwh  = parseFloat((persons[rec.name].kwh  + rec.cost * 1.48).toFixed(2))
      }
      var personArr = []
      var pkeys = Object.keys(persons)
      for (var pi = 0; pi < pkeys.length; pi++) {
        personArr.push({ name: pkeys[pi], cost: persons[pkeys[pi]].cost, kwh: persons[pkeys[pi]].kwh })
      }
      personArr.sort(function(a, b) { return b.cost - a.cost })
      self.setData({
        queryingRange: false, rangeQueried: true,
        rangeResultLabel: start + '  至  ' + end,
        rangeResult: {
          totalKwh:  parseFloat(totalKwh.toFixed(2)),
          totalCost: parseFloat(totalCost.toFixed(2)),
          days:      Object.keys(days).length,
          persons:   personArr,
        },
      })
    }
    fetchBatch(0)
  },
})
