<template>
  <div class="reports">
    <div class="toolbar">
      <button v-if="canOps && !current" class="add" @click="startCreate">＋ 编制复盘报告</button>
      <div class="chips">
        <button class="chip" :class="{on:!filter.status}" @click="setFilter('')">全部 {{ items.length }}</button>
        <button v-for="(txt,k) in dict.status" :key="k" class="chip" :class="[k,{on:filter.status===k}]" @click="setFilter(k)">
          {{ txt }} {{ summary.counts?.[k] || 0 }}
        </button>
        <button v-if="filter.crisis_id" class="chip clear-filter" @click="clearCrisisFilter">× 清除危机 #{{ filter.crisis_id }} 过滤</button>
      </div>
      <span class="me">👤 {{ store.user.name }} · {{ roleText(store.user.role) }}</span>
    </div>
    <p class="hint">🔗 复盘报告仅在危机结案后编制，自动汇总预警、统一时间线、传播路径、跨角色工单与通知回执；ops 编制/送审，admin 审核；送审、手动归档与审核通过均生成不可变版本，支持按历史版本回滚并把状态回写结案档案与统计口径。</p>

    <!-- 新建报告 -->
    <form v-if="creating" class="create-card" @submit.prevent="create">
      <h4>选择结案事件并编制初稿</h4>
      <div class="row">
        <select v-model.number="form.crisis_id" required @change="loadNewSnapshot">
          <option :value="null" disabled>选择已结案危机事件</option>
          <option v-for="c in closedCrises" :key="c.id" :value="c.id">#{{ c.id }} {{ c.title }}</option>
        </select>
        <input v-model="form.title" placeholder="报告标题" />
      </div>
      <div v-if="newSnapshot" class="aggregate-mini">
        <span>预警 <b>{{ newSnapshot.stats.alerts.total }}</b>/待处置 <i>{{ newSnapshot.stats.alerts.open }}</i></span>
        <span>时间线 <b>{{ newSnapshot.stats.timeline }}</b></span>
        <span>传播路径 <b>{{ newSnapshot.stats.paths.total }}</b></span>
        <span>工单 <b>{{ newSnapshot.stats.workOrders.total }}</b></span>
        <span>回执 <b>{{ newSnapshot.stats.notifications.acked }}/{{ newSnapshot.stats.notifications.requireAck }}</b></span>
      </div>
      <textarea v-model="form.sections.overview" placeholder="复盘概述（必填）" required></textarea>
      <textarea v-model="form.sections.rootCause" placeholder="原因分析"></textarea>
      <textarea v-model="form.sections.responseAssessment" placeholder="处置评估"></textarea>
      <textarea v-model="form.sections.improvements" placeholder="改进措施（提交审核前必填）" required></textarea>
      <div class="row">
        <button class="save" type="submit">创建并载入完整汇总</button>
        <button type="button" class="ghost" @click="cancelCreate">取消</button>
      </div>
    </form>

    <!-- 列表 -->
    <template v-if="!current">
      <div class="summary-grid">
        <div class="mini-stat"><b>{{ summary.openDrafts || 0 }}</b><em>编制/审核中</em></div>
        <div class="mini-stat ok"><b>{{ summary.approved || 0 }}</b><em>已归档报告</em></div>
        <div class="mini-stat bad"><b>{{ summary.rejected || 0 }}</b><em>已驳回</em></div>
        <div class="mini-stat"><b>{{ summary.archivedVersions || 0 }}</b><em>历史版本</em></div>
        <div class="mini-stat"><b>{{ summary.coverageRate || 0 }}%</b><em>结案档案覆盖</em></div>
      </div>
      <div v-if="!items.length" class="none">暂无复盘报告（请先在危机处置页完成结案）</div>
      <div class="report-list">
        <div v-for="r in items" :key="r.id" class="report-card" :class="r.status" @click="open(r.id)">
          <div class="r-head">
            <span class="status" :class="r.status">{{ r.statusText }}</span>
            <b>#{{ r.id }} {{ r.title }}</b>
            <span class="version">📚 V{{ r.current_version || 0 }} / {{ r.version_count || 0 }} 版</span>
            <span v-if="r.closure_rolled_back" class="warn">当前结案档案曾回滚</span>
          </div>
          <div class="r-meta">
            <span>危机 <i>#{{ r.crisis_id }} {{ r.crisis_title }}</i></span>
            <span>编制 <i>{{ r.created_by || '—' }}</i></span>
            <span v-if="r.approved_by">归档 <i>{{ r.approved_by }}</i></span>
            <span>更新 <i>{{ r.updated }}</i></span>
          </div>
          <p v-if="r.review_reason" class="review-reason">审核意见：{{ r.review_reason }}</p>
        </div>
      </div>
    </template>

    <!-- 报告详情 -->
    <div v-else-if="report" class="detail">
      <div class="detail-head">
        <button class="ghost back" @click="back">← 返回列表</button>
        <div class="title-box">
          <span class="status big" :class="report.status">{{ report.statusText }}</span>
          <div>
            <h3>#{{ report.id }} {{ report.title }}</h3>
            <small>{{ report.crisis_title }} · 当前 V{{ report.current_version || 0 }} · 汇总于 {{ report.snapshot.generatedAt || '—' }}</small>
          </div>
        </div>
        <div class="head-actions">
          <button v-if="editable" class="ghost" @click="refresh">🔄 重新汇总</button>
          <button v-if="editable" class="ghost" @click="archiveManual">📚 手动归档</button>
          <button v-if="editable" class="submit" @click="submit">提交审核</button>
          <template v-if="report.status==='in_review' && isAdmin">
            <button class="approve" @click="review('approve')">✔ 审核通过</button>
            <button class="changes" @click="review('changes')">↩ 退回修改</button>
            <button class="reject" @click="review('reject')">✕ 驳回</button>
          </template>
          <button v-if="canRollback" class="rollback" @click="rollback">⏪ 回滚版本</button>
        </div>
      </div>

      <div v-if="report.review_reason" class="review-banner" :class="report.status">
        <b>审核意见：</b>{{ report.review_reason }}<em v-if="report.reviewer">（{{ report.reviewer }} · {{ report.reviewed_at }}）</em>
      </div>

      <div class="detail-grid">
        <section class="editor">
          <h4>📝 报告正文</h4>
          <input v-if="editable" v-model="draftTitle" placeholder="报告标题" />
          <h3 v-else class="readonly-title">{{ report.title }}</h3>
          <div v-for="key in sectionKeys" :key="key" class="section-edit">
            <label>{{ sectionNames[key] }}</label>
            <textarea v-if="editable" v-model="draftSections[key]" :rows="key==='overview' ? 4 : 3"></textarea>
            <p v-else>{{ report.sections[key] || '（未填写）' }}</p>
          </div>
          <button v-if="editable" class="save wide" @click="save">保存内容</button>
        </section>

        <aside class="snapshot">
          <h4>📊 自动汇总口径</h4>
          <div class="stat-cards">
            <div><b>{{ sn.alerts.total }}</b><em>预警触发</em><i>{{ sn.alerts.open }} 待处置</i></div>
            <div><b>{{ sn.timeline }}</b><em>时间线</em></div>
            <div><b>{{ sn.paths.total }}</b><em>传播路径</em><i>{{ sn.paths.outbreak }} 爆发</i></div>
            <div><b>{{ sn.workOrders.total }}</b><em>协同工单</em><i>{{ sn.workOrders.open }} 在办</i></div>
            <div><b>{{ sn.notifications.requireAck }}</b><em>需回执</em><i>{{ sn.notifications.acked }} 已确认</i></div>
            <div><b>{{ sn.notifications.ackRate ?? '—' }}{{ sn.notifications.ackRate == null ? '' : '%' }}</b><em>回执率</em></div>
          </div>

          <div class="snap-block">
            <h5>🚨 预警与规则</h5>
            <div v-for="e in snap.alertEvents" :key="e.id" class="snap-row" :class="e.status">
              <b>{{ e.alert_title }} · {{ e.detail }}</b>
              <span>{{ e.post_title || '无关联舆情' }} · {{ e.status==='resolved' ? '已解除' : '未解除' }}</span>
            </div>
            <div v-if="!snap.alertEvents.length" class="none-mini">无预警触发记录</div>
          </div>

          <div class="snap-block">
            <h5>🕒 统一时间线</h5>
            <div class="mini-timeline">
              <div v-for="t in [...snap.timeline].reverse().slice(0, 12)" :key="t.id">
                <b>{{ t.action }}</b><span>{{ t.note }}</span><em>{{ t.time }}</em>
              </div>
            </div>
          </div>

          <div class="snap-block">
            <h5>🕸 传播路径</h5>
            <div v-for="p in snap.propagation" :key="p.id" class="path-snap">
              <b>{{ p.title }}</b>
              <span>{{ stageText(p.stage) }} · 节点 {{ p.metrics.nodeCount }} · KOL {{ p.metrics.kolCount }} · 峰值 {{ p.peak_heat }} · 触达 {{ formatNum(p.metrics.reach) }}</span>
              <small v-for="e in p.metrics.topEdges.slice(0,2)" :key="e.id">{{ e.from_name || '首发' }} → {{ e.to_name }}（热度 {{ e.heat }}）</small>
            </div>
            <div v-if="!snap.propagation.length" class="none-mini">无关联传播路径</div>
          </div>

          <div class="snap-block">
            <h5>📋 跨角色工单</h5>
            <div v-for="w in snap.workOrders" :key="w.id" class="snap-row">
              <b>#{{ w.id }} {{ w.title }}</b>
              <span>{{ woText(w.status) }} · {{ categoryText(w.category) }} · {{ w.assignee || '待分派' }}{{ w.assignee_role ? '·'+roleTeam(w.assignee_role) : '' }}</span>
            </div>
            <div v-if="!snap.workOrders.length" class="none-mini">无关联工单</div>
          </div>

          <div class="snap-block">
            <h5>🔔 通知回执</h5>
            <div v-for="t in snap.notifications.receipts" :key="t.id" class="snap-row" :class="t.status">
              <b>#{{ t.id }} {{ t.title }}</b>
              <span>{{ t.channel_name || '—' }} · {{ notifyText(t.status) }}<template v-if="t.ack_by"> · {{ t.ack_by }} 已回执</template></span>
            </div>
            <div v-if="!snap.notifications.receipts.length" class="none-mini">无需要回执或已升级的通知</div>
          </div>
        </aside>
      </div>

      <div class="bottom-grid">
        <section class="versions">
          <h4>📚 版本归档</h4>
          <div v-for="v in report.versions" :key="v.id" class="version-row" :class="{current:v.version_no===report.current_version}">
            <b>V{{ v.version_no }} {{ v.label }}</b>
            <span>{{ v.sourceText }} · {{ v.created_by }} · {{ v.created }}</span>
            <em v-if="v.restored_at">已于 {{ v.restored_at }} 被 {{ v.restored_by }} 回滚采用</em>
            <small>{{ v.change_note }}</small>
          </div>
        </section>
        <section class="logs">
          <h4>🧾 编制与审核留痕</h4>
          <div v-for="l in report.logs" :key="l.id" class="log-row">
            <b>{{ logText(l.action) }}</b><span>{{ l.detail }}</span><em>{{ l.operator }} · {{ roleText(l.operator_role) }} · {{ l.time }}</em>
          </div>
        </section>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { usePubStore } from '@/store/pub'

const store = usePubStore()
const items = ref([])
const summary = ref({ counts: {} })
const dict = ref({ status: {} })
const incoming = store.reportCrisisFilter
const incomingCrisisId = typeof incoming === 'object' ? incoming?.crisisId : incoming
const incomingReportId = typeof incoming === 'object' ? incoming?.reportId : null
const filter = ref({ status: '', crisis_id: incomingCrisisId || '' })
const current = ref(incomingReportId || null)
const report = ref(null)
const creating = ref(false)
const newSnapshot = ref(null)
const form = ref({ crisis_id: null, title: '', sections: blankSections() })
const draftTitle = ref('')
const draftSections = ref(blankSections())

const sectionKeys = ['overview', 'keyFindings', 'rootCause', 'responseAssessment', 'lessons', 'improvements', 'followups']
const sectionNames = {
  overview: '复盘概述', keyFindings: '关键发现', rootCause: '原因分析', responseAssessment: '处置评估',
  lessons: '经验教训', improvements: '改进措施', followups: '后续行动'
}
const isAdmin = computed(() => store.user.role === 'admin')
const canOps = computed(() => ['admin', 'ops'].includes(store.user.role))
const editable = computed(() => report.value && ['draft', 'changes_requested', 'revision', 'rejected'].includes(report.value.status) && canOps.value)
const canRollback = computed(() => report.value && ['approved', 'revision'].includes(report.value.status) && canOps.value)
const closedCrises = computed(() => store.crises.filter((c) => c.status === 'closed'))
const snap = computed(() => report.value?.snapshot || {})
const sn = computed(() => ({
  alerts: snap.value.stats?.alerts || { total: 0, open: 0 },
  timeline: snap.value.stats?.timeline || 0,
  paths: snap.value.stats?.paths || { total: 0, outbreak: 0 },
  workOrders: snap.value.stats?.workOrders || { total: 0, open: 0 },
  notifications: snap.value.stats?.notifications || { requireAck: 0, acked: 0, ackRate: null }
}))

function blankSections() { return { overview: '', keyFindings: '', rootCause: '', responseAssessment: '', lessons: '', improvements: '', followups: '' } }
function roleText(r) { return { admin: '管理员', ops: '值班员', viewer: '观察员' }[r] || (r || '—') }
function stageText(s) { return { seed: '潜伏期', ferment: '发酵期', outbreak: '爆发期', decline: '回落期' }[s] || s }
function woText(s) { return { todo: '待分派', doing: '处理中', blocked: '已阻塞', done: '已完成', cancelled: '已取消' }[s] || s }
function categoryText(s) { return { pr: '公关口径', legal: '法务合规', ops: '现场运营', support: '客诉跟进', other: '其他' }[s] || s }
function roleTeam(s) { return { pr: '公关', legal: '法务', ops: '运营', support: '客服', admin: '协调组' }[s] || s }
function notifyText(s) { return { pending: '待发送', sent: '已发送', failed: '发送失败', acked: '已回执', escalated: '已升级', paused: '已暂停', cancelled: '已取消' }[s] || s }
function logText(a) {
  return { created: '创建', updated: '编制', snapshot_refreshed: '刷新汇总', submitted: '送审', approved: '审核归档', changes_requested: '退回修改', rejected: '驳回', archived: '手动归档', rolled_back: '版本回滚' }[a] || a
}
function formatNum(n) { return n >= 10000 ? `${(n / 10000).toFixed(1)}万` : n || 0 }

async function load() {
  const q = { scope: 'all' }
  if (filter.value.status) q.status = filter.value.status
  if (filter.value.crisis_id) q.crisis_id = filter.value.crisis_id
  const d = await store.fetchReports(q)
  items.value = d.items
  summary.value = d.summary
  dict.value = d.dict
}
function setFilter(k) { filter.value.status = k; load() }
function clearCrisisFilter() { filter.value.crisis_id = ''; store.reportCrisisFilter = null; load() }
function startCreate() {
  creating.value = true
  form.value = { crisis_id: filter.value.crisis_id ? +filter.value.crisis_id : null, title: '', sections: blankSections() }
  newSnapshot.value = null
  if (form.value.crisis_id) loadNewSnapshot()
}
function cancelCreate() { creating.value = false; newSnapshot.value = null }
async function loadNewSnapshot() {
  if (!form.value.crisis_id) return
  try { newSnapshot.value = await store.fetchReportAggregate(form.value.crisis_id) }
  catch (e) { store.msg(e.message, 'warn') }
}
async function create() {
  try {
    const r = await store.createReport({ ...form.value })
    creating.value = false
    await open(r.id)
  } catch (e) { store.msg(e.message, 'warn') }
}
async function open(id) {
  report.value = await store.fetchReport(id)
  current.value = id
  draftTitle.value = report.value.title
  draftSections.value = { ...blankSections(), ...report.value.sections }
}
function back() { current.value = null; report.value = null; load() }
async function run(fn) {
  try { await fn(); await open(current.value); await load() }
  catch (e) { store.msg(e.message, 'warn') }
}
function save() {
  run(() => store.updateReport(current.value, { title: draftTitle.value, sections: draftSections.value, change_note: `${store.user.name} 保存报告内容` }))
}
function refresh() {
  run(async () => {
    await store.refreshReport(current.value)
    store.msg('已重新汇总最新闭环数据', 'success')
  })
}
function archiveManual() {
  const note = prompt('手动归档说明：', '编制阶段阶段性归档')
  if (note == null) return
  run(() => store.archiveReportVersion(current.value, { change_note: note }))
}
function submit() {
  const note = prompt('送审说明：', '跨角色材料已汇总，提交管理员审核')
  if (note == null) return
  run(async () => {
    await store.updateReport(current.value, { title: draftTitle.value, sections: draftSections.value, refresh: true })
    await store.submitReport(current.value, { change_note: note })
  })
}
function review(action) {
  if (action === 'approve') {
    const reason = prompt('审核通过意见（可留空）：', '同意归档')
    if (reason == null) return
    run(() => store.reviewReport(current.value, 'approve', { reason }))
  } else {
    const reason = prompt(action === 'changes' ? '需要修改的事项：' : '驳回原因：')
    if (!reason || !reason.trim()) return
    run(() => store.reviewReport(current.value, action, { reason }))
  }
}
function rollback() {
  const versions = report.value.versions || []
  if (!versions.length) return store.msg('暂无可回滚的历史版本', 'warn')
  const labels = versions.slice().reverse().map((v) => `${v.version_no}=V${v.version_no} ${v.label}`).join('\n')
  const no = parseInt(prompt(`选择要回滚到的版本号：\n${labels}`, String(report.value.rollback_from_version || versions[0].version_no)), 10)
  if (!no) return
  run(() => store.rollbackReport(current.value, { version_no: no }))
}

onMounted(async () => {
  await load()
  if (current.value) await open(current.value).catch(() => { current.value = null })
})
</script>

<style scoped>
.reports{display:flex;flex-direction:column;gap:12px;}
.toolbar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;}
button{font-family:inherit;border-radius:8px;border:1px solid rgba(120,160,220,.22);background:#13233f;color:#dbe4f3;padding:8px 12px;font-size:12px;cursor:pointer;}
.add{background:linear-gradient(135deg,#43a047,#2e7d32);border-color:transparent;color:#fff;font-weight:700;}
.save{background:#2962ff;border-color:transparent;color:#fff;font-weight:700;}.save.wide{width:100%;margin-top:10px;}
.submit{background:#2962ff;border-color:transparent;color:#fff;font-weight:700;}
.approve{background:#1b5e20;border-color:transparent;color:#a5d6a7;font-weight:700;}
.changes{background:#e65100;border-color:transparent;color:#ffe0b2;}
.reject{background:#b71c1c;border-color:transparent;color:#ffcdd2;}
.rollback{background:#4a148c;border-color:transparent;color:#e1bee7;}
.ghost{color:#90caf9;}
.chips{display:flex;gap:6px;flex-wrap:wrap;}.chip.draft{color:#90caf9;}.chip.in_review{color:#ffe082;}.chip.approved{color:#a5d6a7;}.chip.rejected{color:#ef9a9a;}
.chip.on{background:#24406e;color:#fff;}
.me{margin-left:auto;font-size:12px;color:#8ba2c8;}.hint{font-size:11px;color:#5b6f94;margin:0;}
.summary-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px;}
.mini-stat{background:#0f1b38;border:1px solid rgba(120,160,220,.15);border-radius:10px;padding:12px;text-align:center;}
.mini-stat b{display:block;font-size:22px;color:#fff;}.mini-stat em{font-size:11px;color:#8ba2c8;font-style:normal;}.mini-stat.ok b{color:#81c784;}.mini-stat.bad b{color:#ef9a9a;}
.create-card,.report-card,.editor,.snapshot,.versions,.logs{background:#0f1b38;border:1px solid rgba(120,160,220,.16);border-radius:12px;padding:14px;}
.create-card{display:flex;flex-direction:column;gap:8px;}.create-card h4{margin:0;color:#fff;}.row{display:flex;gap:8px;flex-wrap:wrap;}.row select,.row input{flex:1;min-width:180px;}
input,select,textarea{width:100%;font-family:inherit;background:#13233f;border:1px solid rgba(120,160,220,.2);color:#dbe4f3;border-radius:8px;padding:9px 10px;font-size:12px;}
textarea{resize:vertical;min-height:58px;}
.aggregate-mini{display:flex;gap:12px;flex-wrap:wrap;background:#13233f;border-radius:8px;padding:8px 10px;font-size:11px;color:#8ba2c8;}
.aggregate-mini b{color:#fff;margin:0 3px;}.aggregate-mini i{color:#90caf9;font-style:normal;}
.report-list{display:flex;flex-direction:column;gap:10px;}.report-card{cursor:pointer;border-left:4px solid #90caf9;}
.report-card.in_review{border-left-color:#ffd54f;}.report-card.changes_requested{border-left-color:#ff9800;}.report-card.approved{border-left-color:#66bb6a;}.report-card.rejected{border-left-color:#ef5350;}.report-card.revision{border-left-color:#ce93d8;}
.r-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap;}.r-head b{color:#fff;}.version{font-size:11px;color:#80cbc4;}.warn{font-size:10px;color:#ffab91;border:1px solid rgba(255,171,145,.3);padding:2px 6px;border-radius:5px;}
.r-meta{display:flex;gap:14px;flex-wrap:wrap;font-size:11px;color:#8ba2c8;margin:9px 0;}.r-meta i{color:#90caf9;font-style:normal;}
.review-reason{margin:0;color:#ffe0b2;font-size:12px;}
.status{font-size:10px;border-radius:6px;padding:3px 8px;background:#37474f;color:#cfd8dc;}.status.draft{background:#0d2746;color:#90caf9;}.status.in_review{background:#3f3208;color:#ffe082;}.status.changes_requested{background:#4a280a;color:#ffcc80;}.status.rejected{background:#4a1518;color:#ef9a9a;}.status.approved{background:#173a20;color:#a5d6a7;}.status.revision{background:#351a47;color:#ce93d8;}.status.big{font-size:12px;padding:7px 10px;}
.detail{display:flex;flex-direction:column;gap:12px;}.detail-head{display:flex;align-items:center;gap:12px;flex-wrap:wrap;background:#0f1b38;border:1px solid rgba(120,160,220,.16);border-radius:12px;padding:12px;}
.back{margin-right:4px;}.title-box{display:flex;align-items:center;gap:10px;flex:1;min-width:260px;}.title-box h3{margin:0;color:#fff;font-size:17px;}.title-box small{color:#5b6f94;}.head-actions{display:flex;gap:6px;flex-wrap:wrap;}
.review-banner{border-radius:10px;padding:10px 12px;font-size:12px;background:#3e2723;color:#ffcc80;border:1px solid rgba(255,152,0,.3);}.review-banner.approved{background:#122b18;color:#a5d6a7;border-color:rgba(102,187,106,.3);}
.detail-grid{display:grid;grid-template-columns:minmax(360px,1fr) minmax(430px,1.15fr);gap:12px;}@media(max-width:980px){.detail-grid{grid-template-columns:1fr;}}
.editor h4,.snapshot h4,.versions h4,.logs h4{margin:0 0 12px;color:#ffd54f;font-size:14px;}.section-edit{margin-top:10px;}.section-edit label{display:block;font-size:12px;color:#90caf9;margin-bottom:5px;}.section-edit p{font-size:12px;line-height:1.7;color:#aebadd;margin:0;white-space:pre-wrap;background:#13233f;border-radius:8px;padding:9px;min-height:34px;}.readonly-title{color:#fff;}
.stat-cards{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:12px;}.stat-cards div{background:#13233f;border-radius:8px;padding:9px;text-align:center;}.stat-cards b{display:block;color:#fff;font-size:19px;}.stat-cards em{font-size:10px;color:#8ba2c8;font-style:normal;}.stat-cards i{display:block;font-size:10px;color:#80cbc4;margin-top:2px;font-style:normal;}
.snap-block{border-top:1px solid rgba(120,160,220,.13);padding-top:10px;margin-top:10px;}h5{margin:0 0 8px;color:#90caf9;font-size:12px;}
.snap-row{background:#13233f;border-radius:8px;padding:8px;margin-bottom:6px;border-left:3px solid #546e7a;}.snap-row.resolved,.snap-row.acked{border-left-color:#66bb6a;}.snap-row.open,.snap-row.escalated{border-left-color:#ff9800;}.snap-row b{display:block;color:#dbe4f3;font-size:11px;}.snap-row span{display:block;font-size:10px;color:#8ba2c8;margin-top:3px;}
.mini-timeline{max-height:190px;overflow:auto;border-left:2px solid #243357;padding-left:12px;display:flex;flex-direction:column;gap:8px;}.mini-timeline b{display:block;color:#dbe4f3;font-size:11px;}.mini-timeline span{font-size:10px;color:#8ba2c8;}.mini-timeline em{display:block;font-size:9px;color:#5b6f94;font-style:normal;}
.path-snap{background:#13233f;border-radius:8px;padding:8px;margin-bottom:7px;}.path-snap b{display:block;color:#dbe4f3;font-size:11px;}.path-snap span{display:block;font-size:10px;color:#80cbc4;margin:3px 0;}.path-snap small{display:block;color:#8ba2c8;font-size:10px;}
.none,.none-mini{color:#5b6f94;text-align:center;padding:18px;font-size:12px;}.none-mini{padding:8px;}
.bottom-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px;}@media(max-width:800px){.bottom-grid{grid-template-columns:1fr;}}
.version-row,.log-row{background:#13233f;border-radius:8px;padding:9px;margin-bottom:7px;}.version-row.current{border:1px solid rgba(144,202,249,.35);}.version-row b,.log-row b{display:block;color:#dbe4f3;font-size:12px;}.version-row span,.log-row span{display:block;color:#8ba2c8;font-size:11px;margin:3px 0;}.version-row em,.log-row em{display:block;color:#ce93d8;font-size:10px;font-style:normal;}.version-row small{color:#80cbc4;font-size:10px;}
</style>
