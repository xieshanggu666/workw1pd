import { db } from './db.js'
import { now } from './pipeline.js'

const q = (sql, ...p) => db.prepare(sql).all(...p)
const q1 = (sql, ...p) => db.prepare(sql).get(...p)
const run = (sql, ...p) => db.prepare(sql).run(...p)

export const REPORT_STATUS = {
  draft: '编制中',
  in_review: '待审核',
  changes_requested: '待修改',
  rejected: '已驳回',
  approved: '已归档',
  revision: '修订中'
}
export const VERSION_SOURCE = {
  manual: '手动归档',
  submit: '送审归档',
  approve: '审核归档',
  rollback: '回滚归档'
}
const EDITABLE = new Set(['draft', 'changes_requested', 'revision', 'rejected'])
const SUBMITTABLE = new Set(['draft', 'changes_requested', 'revision'])
const OPEN_STATUSES = ['draft', 'in_review', 'changes_requested', 'revision']

export const REPORT_SECTIONS = {
  overview: '复盘概述',
  keyFindings: '关键发现',
  rootCause: '原因分析',
  responseAssessment: '处置评估',
  lessons: '经验教训',
  improvements: '改进措施',
  followups: '后续行动'
}

function defaultSections() {
  return Object.fromEntries(Object.keys(REPORT_SECTIONS).map((k) => [k, '']))
}

function parseJson(s, fallback) {
  try { return JSON.parse(s || '') || fallback } catch { return fallback }
}

function decorate(r) {
  if (!r) return null
  return {
    ...r,
    statusText: REPORT_STATUS[r.status] || r.status,
    sections: parseJson(r.sections_json, {}),
    snapshot: parseJson(r.snapshot_json, {})
  }
}

function log(reportId, action, detail, actor = { user: '系统', role: '' }) {
  run('INSERT INTO crisis_report_logs (report_id,action,detail,operator,operator_role,time) VALUES (?,?,?,?,?,?)',
    reportId, action, detail || '', actor.user || '系统', actor.role || '', now())
}

function getMetrics(pathId) {
  const nodes = q('SELECT id,node_key,name,kind,channel,followers,first_seen FROM prop_nodes WHERE path_id=? ORDER BY id', pathId)
  const edges = q(`SELECT e.*, fn.name from_name, fn.kind from_kind, tn.name to_name, tn.kind to_kind,
    p.title post_title
    FROM prop_edges e
    LEFT JOIN prop_nodes fn ON fn.id=e.from_node_id
    LEFT JOIN prop_nodes tn ON tn.id=e.to_node_id
    LEFT JOIN posts p ON p.id=e.post_id
    WHERE e.path_id=? ORDER BY e.id`, pathId)
  const byKind = nodes.reduce((acc, n) => { acc[n.kind] = (acc[n.kind] || 0) + 1; return acc }, {})
  const nodeById = new Map(nodes.map((n) => [n.id, n]))
  const children = new Map()
  for (const e of edges) {
    if (!children.has(e.to_node_id)) children.set(e.to_node_id, [])
    children.get(e.to_node_id).push(e.from_node_id)
  }
  // BFS 传播层级：根节点/无上游节点为 0，按转发链取最大深度
  const depth = new Map()
  const roots = nodes.filter((n) => n.kind === 'root' || !edges.some((e) => e.to_node_id === n.id)).map((n) => n.id)
  for (const id of roots) depth.set(id, 0)
  for (let pass = 0; pass < nodes.length + 2; pass++) {
    for (const e of edges) {
      const d = e.from_node_id == null ? 0 : depth.get(e.from_node_id)
      if (d != null) depth.set(e.to_node_id, Math.max(depth.get(e.to_node_id) ?? -1, d + 1))
    }
  }
  const totals = edges.reduce((acc, e) => {
    acc.reposts += e.reposts || 0
    acc.comments += e.comments || 0
    acc.likes += e.likes || 0
    acc.reach += e.reach || 0
    acc.heat = Math.max(acc.heat, e.heat || 0)
    return acc
  }, { reposts: 0, comments: 0, likes: 0, reach: 0, heat: 0 })
  return {
    nodeCount: nodes.length,
    rootCount: byKind.root || 0,
    mediaCount: byKind.media || 0,
    kolCount: byKind.kol || 0,
    normalNodeCount: byKind.node || 0,
    edgeCount: edges.length,
    maxDepth: Math.max(0, ...depth.values()),
    ...totals,
    nodes: nodes.slice(0, 100),
    topEdges: edges.sort((a, b) => (b.heat + b.reach / 10000) - (a.heat + a.reach / 10000)).slice(0, 20)
  }
}

// 汇总预警、统一时间线、传播路径、工单与通知回执；送审/归档时冻结为版本快照
export function buildSnapshot(crisisId) {
  const crisisIdNum = +crisisId
  const crisis = q1(`SELECT c.*,
    (SELECT cc.id FROM crisis_closures cc WHERE cc.crisis_id=c.id AND cc.rolled_back=0 ORDER BY cc.id DESC LIMIT 1) active_closure_id
    FROM crisis c WHERE c.id=?`, crisisIdNum)
  if (!crisis) return null

  const rules = q(`SELECT ca.*, a.title alert_title, a.level alert_level, a.keyword alert_keyword,
      (SELECT COUNT(*) FROM alert_events ae WHERE ae.crisis_id=ca.crisis_id AND ae.alert_id=ca.alert_id) triggers,
      (SELECT COUNT(*) FROM alert_events ae WHERE ae.crisis_id=ca.crisis_id AND ae.alert_id=ca.alert_id AND ae.status='open') open_count
    FROM crisis_alerts ca LEFT JOIN alerts a ON a.id=ca.alert_id
    WHERE ca.crisis_id=? ORDER BY ca.is_origin DESC, ca.alert_id`, crisisIdNum)
  const alertEvents = q(`SELECT ae.*, a.title alert_title, a.level alert_level,
      p.title post_title, p.topic post_topic, p.media, p.heat, p.sentiment, s.name source_name
    FROM alert_events ae
    LEFT JOIN alerts a ON a.id=ae.alert_id
    LEFT JOIN posts p ON p.id=ae.post_id
    LEFT JOIN sources s ON s.id=p.source_id
    WHERE ae.crisis_id=? ORDER BY ae.id ASC`, crisisIdNum)
  const postIds = [...new Set(alertEvents.map((e) => e.post_id).filter((id) => id != null))]
  const relatedPosts = postIds.length
    ? q(`SELECT p.*, s.name source_name FROM posts p LEFT JOIN sources s ON s.id=p.source_id WHERE p.id IN (${postIds.map(() => '?').join(',')})`, ...postIds)
    : []
  const timeline = q('SELECT * FROM crisis_timeline WHERE crisis_id=? ORDER BY id ASC', crisisIdNum)
  const closures = q('SELECT * FROM crisis_closures WHERE crisis_id=? ORDER BY id DESC', crisisIdNum)

  const paths = q('SELECT * FROM prop_paths WHERE crisis_id=? ORDER BY id', crisisIdNum).map((p) => ({
    ...p,
    metrics: getMetrics(p.id)
  }))

  const workOrders = q(`SELECT w.*,
    CASE WHEN w.prop_path_id IS NOT NULL THEN 1 ELSE 0 END has_prop_source,
    pp.title prop_path_title
    FROM work_orders w LEFT JOIN prop_paths pp ON pp.id=w.prop_path_id
    WHERE w.crisis_id=? ORDER BY w.id`, crisisIdNum)
  const woCounts = {}
  const woByRole = {}
  const woByCategory = {}
  for (const w of workOrders) {
    woCounts[w.status] = (woCounts[w.status] || 0) + 1
    if (w.assignee_role) woByRole[w.assignee_role] = (woByRole[w.assignee_role] || 0) + 1
    woByCategory[w.category] = (woByCategory[w.category] || 0) + 1
  }
  const nowMs = Date.now()
  const workOrdersDetail = workOrders.map((w) => ({
    ...w,
    overdue: !['done', 'cancelled'].includes(w.status) && w.due_at != null && w.due_at < nowMs,
    logs: q('SELECT * FROM work_order_logs WHERE wo_id=? ORDER BY id', w.id)
  }))

  const notifyTasks = q(`SELECT t.*, c.name channel_name, c.type channel_type, s.name sub_name
    FROM notify_tasks t
    LEFT JOIN notify_channels c ON c.id=t.channel_id
    LEFT JOIN notify_subs s ON s.id=t.sub_id
    WHERE t.crisis_id=? ORDER BY t.id`, crisisIdNum)
  const notifyCounts = {}
  let requireAck = 0, acked = 0, pendingAck = 0, ackTimeout = 0, escalated = 0
  for (const t of notifyTasks) {
    notifyCounts[t.status] = (notifyCounts[t.status] || 0) + 1
    if (t.require_ack) {
      requireAck++
      if (t.ack_at) acked++
      else if (['sent', 'pending', 'failed', 'paused'].includes(t.status)) pendingAck++
      if (t.escalate_at && !t.ack_at && t.escalate_at < nowMs) ackTimeout++
    }
    if (t.escalated) escalated++
  }
  const receipts = notifyTasks
    .filter((t) => t.require_ack || t.ack_at || t.escalated || ['acked', 'escalated'].includes(t.status))
    .map((t) => ({
      id: t.id, title: t.title, channel_name: t.channel_name, channel_type: t.channel_type,
      status: t.status, require_ack: t.require_ack, ack_by: t.ack_by, ack_at: t.ack_at,
      ack_note: t.ack_note, escalated: t.escalated, escalate_at: t.escalate_at, sent_at: t.sent_at,
      logs: q('SELECT * FROM notify_logs WHERE task_id=? ORDER BY id', t.id)
    }))

  const alertCounts = alertEvents.reduce((acc, e) => {
    acc.total++
    acc[e.status] = (acc[e.status] || 0) + 1
    acc.levels[e.alert_level] = (acc.levels[e.alert_level] || 0) + 1
    return acc
  }, { total: 0, open: 0, resolved: 0, levels: {} })

  return {
    generatedAt: now(),
    generatedAtMs: Date.now(),
    crisis,
    stats: {
      alerts: alertCounts,
      rules: rules.length,
      posts: relatedPosts.length,
      timeline: timeline.length,
      paths: {
        total: paths.length,
        active: paths.filter((p) => p.status === 'active').length,
        outbreak: paths.filter((p) => p.status === 'active' && p.stage === 'outbreak').length,
        nodes: paths.reduce((n, p) => n + p.metrics.nodeCount, 0),
        edges: paths.reduce((n, p) => n + p.metrics.edgeCount, 0),
        reach: paths.reduce((n, p) => n + p.metrics.reach, 0),
        peakHeat: Math.max(0, ...paths.map((p) => p.peak_heat || p.metrics.heat || 0))
      },
      workOrders: {
        total: workOrders.length,
        open: workOrders.filter((w) => ['todo', 'doing', 'blocked'].includes(w.status)).length,
        done: woCounts.done || 0,
        cancelled: woCounts.cancelled || 0,
        overdue: workOrdersDetail.filter((w) => w.overdue).length,
        escalated: workOrders.filter((w) => w.escalated > 0).length,
        counts: woCounts,
        byRole: woByRole,
        byCategory: woByCategory
      },
      notifications: {
        total: notifyTasks.length,
        requireAck, acked, pendingAck, ackTimeout, escalated,
        ackRate: requireAck ? Math.round((acked / requireAck) * 100) : null,
        counts: notifyCounts
      }
    },
    rules,
    alertEvents,
    relatedPosts,
    timeline,
    closures,
    propagation: paths,
    workOrders: workOrdersDetail,
    notifications: { tasks: notifyTasks, receipts }
  }
}

export function listReports({ status = '', crisisId = '', scope = 'active' } = {}) {
  let where = '1=1'
  const args = []
  if (status) { where += ' AND r.status=?'; args.push(status) }
  if (crisisId) { where += ' AND r.crisis_id=?'; args.push(+crisisId) }
  if (scope === 'active') where += ` AND r.status IN (${OPEN_STATUSES.map(() => '?').join(',')})`
  const rows = q(`SELECT r.*, c.title crisis_title, c.status crisis_status, c.level crisis_level,
    cl.summary closure_summary, cl.rolled_back closure_rolled_back,
    (SELECT COUNT(*) FROM crisis_report_versions v WHERE v.report_id=r.id) version_count
    FROM crisis_reports r
    LEFT JOIN crisis c ON c.id=r.crisis_id
    LEFT JOIN crisis_closures cl ON cl.id=r.closure_id
    WHERE ${where} ORDER BY r.id DESC LIMIT 200`, ...args)
  return rows.map((r) => {
    const d = decorate(r)
    delete d.sections
    delete d.snapshot
    return d
  })
}

export function reportSummary() {
  const rows = q('SELECT status, COUNT(*) c FROM crisis_reports GROUP BY status')
  const counts = Object.fromEntries(Object.keys(REPORT_STATUS).map((k) => [k, 0]))
  for (const r of rows) counts[r.status] = r.c
  const closedTotal = q1("SELECT COUNT(*) c FROM crisis WHERE status='closed'").c
  const covered = q1(`SELECT COUNT(DISTINCT c.id) c FROM crisis c
    JOIN crisis_closures cc ON cc.crisis_id=c.id AND cc.rolled_back=0 AND cc.report_status='approved'
    WHERE c.status='closed'`).c
  const approved = counts.approved || 0
  const archivedVersions = q1('SELECT COUNT(*) c FROM crisis_report_versions').c
  return {
    counts,
    openDrafts: counts.draft + counts.in_review + counts.changes_requested + counts.revision,
    approved,
    rejected: counts.rejected,
    closedTotal,
    covered,
    coverageRate: closedTotal ? Math.round((covered / closedTotal) * 100) : 0,
    archivedVersions
  }
}

export function getReport(id) {
  const r = q1(`SELECT r.*, c.title crisis_title, c.status crisis_status, c.level crisis_level, c.topic,
    cl.summary closure_summary
    FROM crisis_reports r
    LEFT JOIN crisis c ON c.id=r.crisis_id
    LEFT JOIN crisis_closures cl ON cl.id=r.closure_id WHERE r.id=?`, id)
  if (!r) return null
  const report = decorate(r)
  report.versions = q('SELECT id,version_no,label,change_note,source,created_by,created_by_role,created,restored_at,restored_by FROM crisis_report_versions WHERE report_id=? ORDER BY version_no DESC', id)
    .map((v) => ({ ...v, sourceText: VERSION_SOURCE[v.source] || v.source }))
  report.logs = q('SELECT * FROM crisis_report_logs WHERE report_id=? ORDER BY id DESC', id)
  return report
}

export function getReportVersion(reportId, versionNo) {
  return q1('SELECT * FROM crisis_report_versions WHERE report_id=? AND version_no=?', reportId, versionNo)
}

function activeClosure(crisisId) {
  return q1('SELECT * FROM crisis_closures WHERE crisis_id=? AND rolled_back=0 ORDER BY id DESC LIMIT 1', crisisId)
}

// 结案回滚后再次结案：把各事件最新报告挂到新的有效结案档案，保证档案/统计口径连续
export function syncActiveClosureReports() {
  const crises = q("SELECT DISTINCT crisis_id FROM crisis_reports").map((r) => r.crisis_id)
  for (const crisisId of crises) {
    const closure = activeClosure(crisisId)
    const latest = q1('SELECT * FROM crisis_reports WHERE crisis_id=? ORDER BY id DESC LIMIT 1', crisisId)
    if (!closure || !latest) continue
    const status = latest.status === 'approved'
      ? 'approved'
      : OPEN_STATUSES.includes(latest.status) ? latest.status : ''
    run('UPDATE crisis_closures SET report_id=?, report_version=?, report_status=? WHERE id=?',
      latest.id, latest.current_version || null, status, closure.id)
  }
}

function writeVersion(report, { source, label, changeNote, sections, snapshot, actor }) {
  const no = (report.latest_version || 0) + 1
  run(`INSERT INTO crisis_report_versions
    (report_id,version_no,label,change_note,source,sections_json,snapshot_json,created_by,created_by_role,created)
    VALUES (?,?,?,?,?,?,?,?,?,?)`,
    report.id, no, label || `V${no}`, changeNote || '', source,
    JSON.stringify(sections), JSON.stringify(snapshot), actor.user || '系统', actor.role || '', now())
  return no
}

function syncClosure(report, status = report.status, versionNo = report.current_version) {
  // 结案可反复回滚/再结案：状态优先回写当前有效档案；报告创建时的 closure_id 作为兜底
  const active = activeClosure(report.crisis_id)
  const closureId = active ? active.id : report.closure_id
  if (!closureId) return
  run('UPDATE crisis_closures SET report_id=?, report_version=?, report_status=? WHERE id=?',
    report.id, versionNo || null, status === 'approved' ? 'approved' : status, closureId)
}

export function createReport(body, actor) {
  const crisisId = +(body?.crisis_id || 0)
  const crisis = q1('SELECT * FROM crisis WHERE id=?', crisisId)
  if (!crisis) return { error: '所属危机事件不存在' }
  if (crisis.status !== 'closed') return { error: '复盘报告需在危机结案后编制' }
  const closure = activeClosure(crisisId)
  if (!closure) return { error: '未找到有效结案档案，无法编制复盘报告' }
  const open = q1(`SELECT id FROM crisis_reports WHERE crisis_id=? AND status IN (${OPEN_STATUSES.map(() => '?').join(',')}) LIMIT 1`,
    crisisId, ...OPEN_STATUSES)
  if (open) return { error: `该事件已有进行中的复盘报告 #${open.id}` }

  const ts = now()
  const title = String(body?.title || '').trim() || `${crisis.title}复盘报告`
  const sections = { ...defaultSections(), ...(body?.sections && typeof body.sections === 'object' ? body.sections : {}) }
  const snapshot = buildSnapshot(crisisId)
  const r = run(`INSERT INTO crisis_reports
    (crisis_id,closure_id,title,status,sections_json,snapshot_json,current_version,latest_version,created_by,created_by_role,created,updated)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    crisisId, closure.id, title, 'draft', JSON.stringify(sections), JSON.stringify(snapshot), 0, 0,
    actor.user, actor.role, ts, ts)
  const id = Number(r.lastInsertRowid)
  syncClosure({ id, closure_id: closure.id }, 'draft', 0)
  log(id, 'created', `基于结案档案 #${closure.id} 创建复盘报告，已汇总预警、时间线、传播路径、工单与通知回执`, actor)
  return { ok: true, id, report: getReport(id) }
}

export function updateReport(id, body, actor) {
  const r = q1('SELECT * FROM crisis_reports WHERE id=?', id)
  if (!r) return null
  if (!EDITABLE.has(r.status)) return { error: `当前状态（${REPORT_STATUS[r.status]}）不可编辑，请先退回/回滚为修订状态` }
  const incoming = body?.sections && typeof body.sections === 'object' ? body.sections : {}
  const sections = parseJson(r.sections_json, defaultSections())
  for (const key of Object.keys(REPORT_SECTIONS)) {
    if (typeof incoming[key] === 'string') sections[key] = incoming[key].trim()
  }
  const snapshot = body?.refresh === false ? parseJson(r.snapshot_json, {}) : buildSnapshot(r.crisis_id)
  const title = String(body?.title || r.title).trim() || r.title
  run('UPDATE crisis_reports SET title=?, sections_json=?, snapshot_json=?, updated=? WHERE id=?',
    title, JSON.stringify(sections), JSON.stringify(snapshot), now(), id)
  syncClosure({ id, closure_id: r.closure_id, status: r.status }, r.status, r.current_version)
  log(id, 'updated', body?.change_note ? String(body.change_note) : '更新报告内容并刷新汇总快照', actor)
  return { ok: true, report: getReport(id) }
}

export function submitReport(id, body, actor) {
  const r = q1('SELECT * FROM crisis_reports WHERE id=?', id)
  if (!r) return null
  if (!SUBMITTABLE.has(r.status)) return { error: `当前状态（${REPORT_STATUS[r.status]}）不能提交审核` }
  const sections = parseJson(r.sections_json, {})
  if (!String(sections.overview || '').trim()) return { error: '请先填写复盘概述' }
  if (!String(sections.improvements || '').trim()) return { error: '请先填写改进措施' }
  const snapshot = buildSnapshot(r.crisis_id)
  const updatedSections = { ...defaultSections(), ...sections }
  run('UPDATE crisis_reports SET sections_json=?, snapshot_json=? WHERE id=?',
    JSON.stringify(updatedSections), JSON.stringify(snapshot), id)
  const after = { ...r, sections: updatedSections, snapshot }
  const no = writeVersion(after, {
    source: 'submit', label: `V${(r.latest_version || 0) + 1} 送审版`,
    changeNote: String(body?.change_note || '提交审核'), sections: updatedSections, snapshot, actor
  })
  const ts = now()
  run(`UPDATE crisis_reports SET status='in_review', current_version=?, latest_version=?,
    submitted_by=?, submitted_by_role=?, submitted_at=?, review_reason='', reviewed_at=NULL, updated=?
    WHERE id=?`, no, no, actor.user, actor.role, ts, ts, id)
  syncClosure({ id, closure_id: r.closure_id, status: 'in_review' }, 'in_review', no)
  log(id, 'submitted', `提交管理员审核并归档送审版 V${no}`, actor)
  return { ok: true, version: no, report: getReport(id) }
}

export function reviewReport(id, action, body, actor) {
  const r = q1('SELECT * FROM crisis_reports WHERE id=?', id)
  if (!r) return null
  if (r.status !== 'in_review') return { error: `当前状态（${REPORT_STATUS[r.status]}）不在待审核状态` }
  const reason = String(body?.reason || '').trim()
  const ts = now()
  if (action === 'changes') {
    if (!reason) return { error: '请填写需修改事项' }
    run(`UPDATE crisis_reports SET status='changes_requested', reviewer=?, reviewer_role=?, review_reason=?, reviewed_at=?, updated=? WHERE id=?`,
      actor.user, actor.role, reason, ts, ts, id)
    syncClosure({ id, closure_id: r.closure_id, status: 'changes_requested' }, 'changes_requested', r.current_version)
    log(id, 'changes_requested', `审核退回：${reason}`, actor)
    return { ok: true, report: getReport(id) }
  }
  if (action === 'reject') {
    if (!reason) return { error: '请填写驳回原因' }
    run(`UPDATE crisis_reports SET status='rejected', reviewer=?, reviewer_role=?, review_reason=?, reviewed_at=?, updated=? WHERE id=?`,
      actor.user, actor.role, reason, ts, ts, id)
    syncClosure({ id, closure_id: r.closure_id, status: 'rejected' }, 'rejected', r.current_version)
    log(id, 'rejected', `审核驳回：${reason}`, actor)
    return { ok: true, report: getReport(id) }
  }
  if (action !== 'approve') return { error: '未知审核动作' }

  const sections = parseJson(r.sections_json, defaultSections())
  const snapshot = parseJson(r.snapshot_json, {})
  const before = { ...r, latest_version: r.latest_version }
  const no = writeVersion(before, {
    source: 'approve', label: `V${(r.latest_version || 0) + 1} 正式归档版`,
    changeNote: reason || '审核通过并归档', sections, snapshot, actor
  })
  run(`UPDATE crisis_reports SET status='approved', current_version=?, latest_version=?,
    approved_by=?, approved_by_role=?, approved_at=?, archived_by=?, archived_by_role=?, archived_at=?,
    reviewer=?, reviewer_role=?, review_reason=COALESCE(NULLIF(review_reason,''),?), reviewed_at=?, updated=?
    WHERE id=?`,
    no, no, actor.user, actor.role, ts, actor.user, actor.role, ts,
    actor.user, actor.role, reason, ts, ts, id)
  const approved = { ...r, id, closure_id: r.closure_id, current_version: no, status: 'approved' }
  syncClosure(approved, 'approved', no)
  log(id, 'approved', `审核通过，正式归档 V${no}，状态已回写结案档案与统计口径${reason ? '：' + reason : ''}`, actor)
  return { ok: true, version: no, report: getReport(id) }
}

export function archiveReportVersion(id, body, actor) {
  const r = q1('SELECT * FROM crisis_reports WHERE id=?', id)
  if (!r) return null
  if (r.status === 'in_review' || r.status === 'rejected') return { error: `当前状态（${REPORT_STATUS[r.status]}）不能手动归档` }
  const sections = parseJson(r.sections_json, defaultSections())
  const snapshot = body?.refresh === false ? parseJson(r.snapshot_json, {}) : buildSnapshot(r.crisis_id)
  run('UPDATE crisis_reports SET snapshot_json=?, updated=? WHERE id=?', JSON.stringify(snapshot), now(), id)
  const no = writeVersion({ ...r, snapshot }, {
    source: 'manual', label: `V${(r.latest_version || 0) + 1} 手动归档`,
    changeNote: String(body?.change_note || '手动归档当前内容'), sections, snapshot, actor
  })
  run('UPDATE crisis_reports SET current_version=?, latest_version=?, updated=? WHERE id=?', no, no, now(), id)
  const updated = { ...r, current_version: no, status: r.status }
  syncClosure(updated, r.status, no)
  log(id, 'archived', `手动归档版本 V${no}`, actor)
  return { ok: true, version: no, report: getReport(id) }
}

export function rollbackReportVersion(id, body, actor) {
  const r = q1('SELECT * FROM crisis_reports WHERE id=?', id)
  if (!r) return null
  if (!['approved', 'revision'].includes(r.status)) return { error: '仅已归档或修订中的报告可回滚版本' }
  const targetNo = +(body?.version_no || 0)
  const target = getReportVersion(id, targetNo)
  if (!target) return { error: '目标归档版本不存在' }
  const targetSections = parseJson(target.sections_json, defaultSections())
  const targetSnapshot = parseJson(target.snapshot_json, {})
  const ts = now()
  const no = writeVersion({ ...r }, {
    source: 'rollback', label: `V${(r.latest_version || 0) + 1} 回滚自 V${targetNo}`,
    changeNote: `回滚到 V${targetNo}：${target.change_note || target.label || ''}`,
    sections: targetSections, snapshot: targetSnapshot, actor
  })
  run('UPDATE crisis_report_versions SET restored_at=?, restored_by=? WHERE id=?', ts, actor.user, target.id)
  run(`UPDATE crisis_reports SET status='revision', sections_json=?, snapshot_json=?, current_version=?, latest_version=?,
    rollback_from_version=?, review_reason='', reviewed_at=NULL, updated=? WHERE id=?`,
    JSON.stringify(targetSections), JSON.stringify(targetSnapshot), no, no, targetNo, ts, id)
  syncClosure({ ...r, status: 'revision' }, 'revision', no)
  log(id, 'rolled_back', `版本回滚：当前内容回到 V${targetNo}，并生成不可变修订版 V${no}；结案档案状态同步为修订中`, actor)
  return { ok: true, version: no, fromVersion: targetNo, report: getReport(id) }
}

export function refreshReportSnapshot(id, actor) {
  const r = q1('SELECT * FROM crisis_reports WHERE id=?', id)
  if (!r) return null
  if (!EDITABLE.has(r.status)) return { error: `当前状态（${REPORT_STATUS[r.status]}）不能刷新汇总，请先退回或回滚报告` }
  const snapshot = buildSnapshot(r.crisis_id)
  run('UPDATE crisis_reports SET snapshot_json=?, updated=? WHERE id=?', JSON.stringify(snapshot), now(), id)
  log(id, 'snapshot_refreshed', '重新汇总预警、时间线、传播路径、工单与通知回执', actor)
  return { ok: true, snapshot, report: getReport(id) }
}

export function reportLogs(id) {
  return q('SELECT * FROM crisis_report_logs WHERE report_id=? ORDER BY id DESC', id)
}

// 演示种子：为首个已结案事件生成一份已审核归档复盘报告（老库升级也幂等补齐）
export function seedReports() {
  if (q1('SELECT COUNT(*) c FROM crisis_reports').c > 0) return 0
  const c = q1(`SELECT c.id FROM crisis c
    JOIN crisis_closures cc ON cc.crisis_id=c.id AND cc.rolled_back=0
    WHERE c.status='closed' ORDER BY c.id LIMIT 1`)
  if (!c) return 0
  const sections = {
    overview: '事件由会员定价调整引发，舆情在客服答疑与权益说明发布后逐步回落，未演变为大规模抵制。',
    keyFindings: '首波负面集中于性价比与权益感知；中性讨论占比较高，核心诉求是解释新增权益与老用户补偿。',
    rootCause: '公告侧重价格调整，未同步说明权益升级、适用范围和老用户过渡安排，导致信息落差。',
    responseAssessment: '官方说明发布及时，但客服口径初期不完全一致；后续集中答疑后情绪明显缓和。',
    lessons: '价格类政策发布前应准备 Q&A、会员权益对比和分用户群沟通话术，并提前校准客服口径。',
    improvements: '建立定价变更评审清单；上线前完成客服培训；监测高互动用户与会员社区反馈；设置 72 小时复盘节点。',
    followups: '运营：完善会员权益对比页；客服：沉淀标准问答；公关：跟踪二次发酵风险。'
  }
  const ops = { user: '李澈', role: 'ops' }
  const admin = { user: '张岚', role: 'admin' }
  const created = createReport({ crisis_id: c.id, sections }, ops)
  if (created.error) return 0
  submitReport(created.id, { change_note: '完成跨角色材料汇总，提交审核' }, ops)
  reviewReport(created.id, 'approve', { reason: '材料完整，统计口径与结案档案一致，同意归档' }, admin)
  return 1
}
