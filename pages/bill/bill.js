const app = getApp()
const UNIT_PRICE = 1.48           // 度 / 元（电费单价，可按需修改）
const WEEK_DAYS  = ['日','一','二','三','四','五','六']
const DB         = () => wx.cloud.database()

// ── 纯函数：从 "2026/4/19" 提取 "2026/4" ──────────────────────────
function ymFromDate(dateStr) {
  var p = dateStr.split('/')
  return p[0] + '/' + p[1]
}

// ── 纯函数：格式化 Date → "2026/4/19" ────────────────────────────
function fmtDate(d) {
  return d.getFullYear() + '/' + (d.getMonth()+1) + '/' + d.getDate()
}

// ── 纯函数：构建 42 格日历数组（class 在此预算）────────────────────
function buildCalendar(year, month, costDates, selectedDate) {
  var todayStr = fmtDate(new Date())
  var sel      = selectedDate || ''
  var firstDay = new Date(year, month-1, 1)
  var lastDate = new Date(year, month, 0).getDate()
  var startWd  = firstDay.getDay()
  var days     = []

  // 上月占位格
  for (var i = startWd - 1; i >= 0; i--) {
    var d0  = new Date(year, month-1, -i)
    var ds0 = fmtDate(d0)
    days.push({ day: d0.getDate(), dateStr: ds0, isCurrentMonth: false,
      hasCost: false, cellClass: 'day-cell', numClass: 'day-num-out', dotClass: 'dot' })
  }

  // 当月
  for (var d2 = 1; d2 <= lastDate; d2++) {
    var ds2  = year + '/' + month + '/' + d2
    var isSel   = ds2 === sel
    var isToday = ds2 === todayStr && !isSel
    var hasCost = !!(costDates && costDates[ds2])
    days.push({
      day:            d2,
      dateStr:        ds2,
      isCurrentMonth: true,
      hasCost:        hasCost,
      cellClass: isSel ? 'day-cell day-cell-sel' : 'day-cell',
      numClass:  isSel ? 'day-num-sel' : (isToday ? 'day-num-today' : 'day-num'),
      dotClass:  isSel ? 'dot-sel' : 'dot',
    })
  }

  // 下月占位格（补满 42 格）
  var rem = 42 - days.length
  for (var d3 = 1; d3 <= rem; d3++) {
    var dd  = new Date(year, month, d3)
    var ds3 = fmtDate(dd)
    days.push({ day: dd.getDate(), dateStr: ds3, isCurrentMonth: false,
      hasCost: false, cellClass: 'day-cell', numClass: 'day-num-out', dotClass: 'dot' })
  }
  return days
}

Page({
  data: {
    weekDays:          WEEK_DAYS,
    viewYear:          0,
    viewMonth:         0,
    currentYearMonth:  '',
    currentYearMonthKey: '',
    calendarDays:      [],
    costDates:         {},

    selectedDate:   '',
    showDetail:     false,
    loadingDay:     false,
    dayRecords:     [],         // [{ _id, name, absentHours, cost, kWh }]
    savingAbsent:   false,

    kWh:            '',
    totalCost:      0,          // kWh ÷ UNIT_PRICE 预览

    calculating:    false,
    results:        [],         // 当日分摊结果
    resultTotal:    0,

    monthlySummary: [],
    monthlyTotal:   0,
    loadingMonthly: false,

  },

  // ─────────────────────────────────────────────────────
  // 生命周期
  // ─────────────────────────────────────────────────────
  onLoad: function() {
    var now = new Date()
    this._setViewMonth(now.getFullYear(), now.getMonth() + 1)
  },

  onShow: function() {
    var k = this.data.currentYearMonthKey
    if (!k) return
    var p = k.split('/')
    this._fetchMonthly(parseInt(p[0]), parseInt(p[1]))
  },

  // ─────────────────────────────────────────────────────
  // 月份切换
  // ─────────────────────────────────────────────────────
  prevMonth: function() {
    var y = this.data.viewYear, m = this.data.viewMonth - 1
    if (m < 1) { m = 12; y-- }
    this._setViewMonth(y, m)
  },
  nextMonth: function() {
    var y = this.data.viewYear, m = this.data.viewMonth + 1
    if (m > 12) { m = 1; y++ }
    this._setViewMonth(y, m)
  },
  _setViewMonth: function(year, month) {
    // 先同步渲染空日历，再异步拉取月度数据（防止白屏等待）
    this.setData({
      viewYear:          year,
      viewMonth:         month,
      currentYearMonth:  year + '年' + month + '月',
      currentYearMonthKey: year + '/' + month,
      showDetail:        false,
      results:           [],
      calendarDays:      buildCalendar(year, month, {}, ''),
    })
    this._fetchMonthly(year, month)
  },

  // ─────────────────────────────────────────────────────
  // 点击日历某天
  // ─────────────────────────────────────────────────────
  onDayTap: function(e) {
    var day = e.currentTarget.dataset.day
    if (!day.isCurrentMonth) return
    var sel = day.dateStr
    this.setData({
      selectedDate:  sel,
      showDetail:    true,
      dayRecords:    [],
      kWh:           '',
      totalCost:     0,
      results:       [],
      resultTotal:   0,
      savingAbsent:  false,
      // 立刻更新日历选中状态
      calendarDays: buildCalendar(this.data.viewYear, this.data.viewMonth, this.data.costDates, sel),
    })
    this._fetchDayRecords(sel)
  },

  closeDetail: function() {
    this.setData({ showDetail: false })
  },

  // ─────────────────────────────────────────────────────
  // 读取当天所有记录（含已计算结果恢复）
  // ─────────────────────────────────────────────────────
  _fetchDayRecords: function(date) {
    var self = this
    self.setData({ loadingDay: true })
    DB().collection('daily_bills').where({ date: date }).get({
      success: function(res) {
        var existing  = res.data
        var roommates = app.globalData.roommates
        // 按 roommates 顺序整理记录
        var dayRecords = []
        for (var i = 0; i < roommates.length; i++) {
          var name  = roommates[i]
          var found = null
          for (var j = 0; j < existing.length; j++) {
            if (existing[j].name === name) { found = existing[j]; break }
          }
          dayRecords.push({
            _id:         found ? found._id : null,
            name:        name,
            absentHours: found ? (parseFloat(found.absentHours) || 0) : 0,
            cost:        found ? (found.cost || 0) : 0,
            kWh:         found ? (found.kWh  || 0) : 0,
          })
        }

        // 恢复已有计算结果（从数据库里的 cost 字段读出）
        var hasCost = false
        for (var ri = 0; ri < dayRecords.length; ri++) {
          if (dayRecords[ri].cost > 0) { hasCost = true; break }
        }
        var results = [], resultTotal = 0
        if (hasCost) {
          for (var ci = 0; ci < dayRecords.length; ci++) {
            var dr  = dayRecords[ci]
            var ph  = parseFloat((24 - dr.absentHours).toFixed(2))
            results.push({ name: dr.name, presentHours: ph, absentHours: dr.absentHours, amount: dr.cost })
            resultTotal += dr.cost
          }
          resultTotal = parseFloat(resultTotal.toFixed(2))
        }

        // 恢复度数输入框
        var kwhSaved = 0
        for (var ki = 0; ki < existing.length; ki++) {
          if (existing[ki].kWh > 0) { kwhSaved = existing[ki].kWh; break }
        }
        if (kwhSaved > 0) {
          self.setData({ kWh: kwhSaved.toString(), totalCost: parseFloat((kwhSaved / UNIT_PRICE).toFixed(2)) })
        }
        self.setData({ dayRecords: dayRecords, results: results, resultTotal: resultTotal, loadingDay: false })
      },
      fail: function(err) {
        self.setData({ loadingDay: false })
        console.error('[_fetchDayRecords]', err)
      },
    })
  },

  // ─────────────────────────────────────────────────────
  // Slider 拖动更新缺席时长（仅本地，需手动保存）
  // ─────────────────────────────────────────────────────
  onAbsentChange: function(e) {
    var index = e.currentTarget.dataset.index
    var value = parseFloat(e.detail.value) || 0
    this.setData({ ['dayRecords[' + index + '].absentHours']: value })
  },

  // ─────────────────────────────────────────────────────
  // 保存缺席记录（逐条 upsert）
  // ─────────────────────────────────────────────────────
  saveAbsent: function() {
    var self = this
    if (self.data.savingAbsent) return
    var dayRecords   = self.data.dayRecords
    var selectedDate = self.data.selectedDate
    var yearMonth    = ymFromDate(selectedDate)
    self.setData({ savingAbsent: true })
    wx.showLoading({ title: '保存中…' })
    var db = DB()

    var doSave = function(i) {
      if (i >= dayRecords.length) {
        wx.hideLoading()
        self.setData({ savingAbsent: false, results: [], resultTotal: 0 })
        wx.showToast({ title: '保存成功 ✓', icon: 'success' })
        return
      }
      var r = dayRecords[i]
      var op
      if (r._id) {
        op = db.collection('daily_bills').doc(r._id)
               .update({ data: { absentHours: r.absentHours, cost: 0, yearMonth: yearMonth } })
      } else {
        op = db.collection('daily_bills').add({
          data: { name: r.name, date: selectedDate, yearMonth: yearMonth,
                  absentHours: r.absentHours, cost: 0, createTime: db.serverDate() }
        }).then(function(addRes) {
          self.setData({ ['dayRecords[' + i + ']._id']: addRes._id })
          return addRes
        })
      }
      op.then(function() { doSave(i + 1) })
        .catch(function(err) { console.error('[saveAbsent i=' + i + ']', err); doSave(i + 1) })
    }
    doSave(0)
  },

  // ─────────────────────────────────────────────────────
  // 度数输入
  // ─────────────────────────────────────────────────────
  onKwhInput: function(e) {
    var kWh   = e.detail.value !== undefined ? e.detail.value : e.detail
    var kwNum = parseFloat(kWh)
    var cost  = kwNum > 0 ? parseFloat((kwNum / UNIT_PRICE).toFixed(2)) : 0
    this.setData({ kWh: kWh, totalCost: cost })
  },

  // ─────────────────────────────────────────────────────
  // 核心：计算当日分摊
  //
  // 公式（来自报告第三节）：
  //   Pi     = 24 - absentHours_i
  //   Ptotal = ΣPi
  //   Chour  = totalCost / Ptotal
  //   Ei     = Pi × Chour
  //
  // 边界：若所有人都缺席（Ptotal=0），则按人头平分
  // ─────────────────────────────────────────────────────
  calculateDaily: function() {
    var self = this
    if (self.data.calculating) return
    var kWh       = self.data.kWh
    var totalCost = parseFloat(self.data.totalCost)
    if (!kWh || !(totalCost > 0)) {
      wx.showToast({ title: '请先输入用电度数', icon: 'none' })
      return
    }

    self.setData({ calculating: true })
    wx.showLoading({ title: '计算中…' })

    var selectedDate = self.data.selectedDate
    var dayRecords   = self.data.dayRecords
    var yearMonth    = ymFromDate(selectedDate)
    var db           = DB()
    var kWhNum       = parseFloat(kWh)
    var roommates    = app.globalData.roommates

    // 1. 计算每人在宿时长
    var rows = []
    for (var i = 0; i < roommates.length; i++) {
      var name     = roommates[i]
      var rec      = null
      for (var j = 0; j < dayRecords.length; j++) {
        if (dayRecords[j].name === name) { rec = dayRecords[j]; break }
      }
      var absent  = rec ? (parseFloat(rec.absentHours) || 0) : 0
      var present = parseFloat((24 - absent).toFixed(2))
      rows.push({ _id: rec ? rec._id : null, name: name, absentHours: absent, presentHours: present })
    }

    // 2. 总在宿时长
    var ptotal = 0
    for (var a = 0; a < rows.length; a++) ptotal += rows[a].presentHours
    ptotal = parseFloat(ptotal.toFixed(4))

    // 3. 计算 Ei
    var results = []
    for (var b = 0; b < rows.length; b++) {
      var row    = rows[b]
      var amount = ptotal > 0
        ? parseFloat((row.presentHours * totalCost / ptotal).toFixed(2))
        : parseFloat((totalCost / rows.length).toFixed(2))
      results.push({ _id: row._id, name: row.name,
        absentHours: row.absentHours, presentHours: row.presentHours, amount: amount })
    }

    // 4. 合计
    var resultTotal = 0
    for (var c = 0; c < results.length; c++) resultTotal += results[c].amount
    resultTotal = parseFloat(resultTotal.toFixed(2))

    // 5. 逐条写入数据库
    var doWrite = function(i) {
      if (i >= results.length) {
        // 写完后：更新 UI + 立即刷新月度汇总
        wx.hideLoading()
        wx.showToast({ title: '计算完成 ✓', icon: 'success', duration: 2000 })
        self.setData({ calculating: false, results: results, resultTotal: resultTotal })
        var dp = selectedDate.split('/')
        self._fetchMonthly(parseInt(dp[0]), parseInt(dp[1]))
        return
      }
      var res       = results[i]
      var writeData = { cost: res.amount, kWh: kWhNum, yearMonth: yearMonth, absentHours: res.absentHours }
      var op
      if (res._id) {
        op = db.collection('daily_bills').doc(res._id).update({ data: writeData })
      } else {
        op = db.collection('daily_bills').add({
          data: { name: res.name, date: selectedDate, cost: res.amount,
                  kWh: kWhNum, yearMonth: yearMonth, absentHours: res.absentHours,
                  createTime: db.serverDate() }
        }).then(function(addRes) {
          results[i]._id = addRes._id
          // 同步更新 dayRecords 里的 _id，方便下次重算
          self.setData({ ['dayRecords[' + i + ']._id']: addRes._id })
          return addRes
        })
      }
      op.then(function()  { doWrite(i + 1) })
        .catch(function(err) { console.error('[doWrite i=' + i + ']', err); doWrite(i + 1) })
    }
    doWrite(0)
  },

  // ─────────────────────────────────────────────────────
  // 月度汇总
  //
  // 关键：用 where({ yearMonth }) 精确查询，不依赖 date 字符串前缀匹配
  // limit(100) 是微信小程序云数据库客户端 SDK 上限
  // ─────────────────────────────────────────────────────
  _fetchMonthly: function(year, month) {
    var self      = this
    var yearMonth = year + '/' + month
    var prefix    = year + '/' + month + '/'
    self.setData({ loadingMonthly: true })

    // 微信云数据库客户端 SDK 单次最多返回 20 条
    // 必须用 skip() 分批翻页拉取全部数据
    var allRows = []
    function fetchBatch(skip) {
      DB().collection('daily_bills').skip(skip).limit(20).get({
        success: function(res) {
          var batch = res.data
          allRows = allRows.concat(batch)
          if (batch.length === 20) {
            // 还可能有更多，继续翻页
            fetchBatch(skip + 20)
          } else {
            // 全部拉完，开始过滤计算
            processAll(allRows)
          }
        },
        fail: function(err) {
          console.error('[_fetchMonthly batch skip=' + skip + ']', err)
          // 即使某批失败，用已拿到的数据继续处理
          processAll(allRows)
        },
      })
    }

    function processAll(data) {
      // 过滤当月记录（兼容 yearMonth 字段和 date 前缀两种情况）
      var monthRows = []
      for (var i = 0; i < data.length; i++) {
        var r = data[i]
        var dateStr = r.date || ''
        var inMonth = (r.yearMonth === yearMonth) || (dateStr.indexOf(prefix) === 0)
        if (inMonth) monthRows.push(r)
      }

      // 同名同日去重，保留 cost 最大那条
      var best = {}
      for (var j = 0; j < monthRows.length; j++) {
        var r2 = monthRows[j]
        if (!r2.cost || r2.cost <= 0) continue
        var key = r2.name + '|' + (r2.date || '')
        if (!best[key] || r2.cost > best[key].cost) best[key] = r2
      }

      // 按姓名汇总 & 日历打点
      var totals = {}, costDates = {}
      var bkeys  = Object.keys(best)
      for (var bi = 0; bi < bkeys.length; bi++) {
        var rec = best[bkeys[bi]]
        totals[rec.name] = parseFloat(((totals[rec.name] || 0) + rec.cost).toFixed(2))
        if (rec.date) costDates[rec.date] = true
      }

      var summary = []
      var nkeys   = Object.keys(totals)
      for (var ni = 0; ni < nkeys.length; ni++) {
        summary.push({ name: nkeys[ni], total: totals[nkeys[ni]] })
      }
      summary.sort(function(a, b) { return b.total - a.total })

      var monthlyTotal = 0
      for (var si = 0; si < summary.length; si++) monthlyTotal += summary[si].total
      monthlyTotal = parseFloat(monthlyTotal.toFixed(2))

      self.setData({
        monthlySummary:  summary,
        monthlyTotal:    monthlyTotal,
        loadingMonthly:  false,
        costDates:       costDates,
        calendarDays:    buildCalendar(year, month, costDates, self.data.selectedDate),
      })
    }

    fetchBatch(0)
  },
})
