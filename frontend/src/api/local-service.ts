import { MODULE_BY_KEY } from '@/data/modules'
import {
  allRows,
  listCollection,
  listRows,
  resetCollections,
  resetRows,
  saveCollection,
  saveRows,
} from '@/data/local-store'
import type {
  ActionResult,
  ChannelPropagationDetail,
  EntryRow,
  ModuleMeta,
  OverviewResult,
  PageResult,
  PropagationItem,
  PropagationRecord,
  SyncBatch,
} from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚', '停止']

const INGEST_KEY = 'ingest'
const BRONZE_KEY = 'bronze'
const SILVER_KEY = 'silver'
const CHANNEL_STOPPED = '已停止'
const CHANNEL_RUNNING = '运行中'
const TABLE_DISABLED = '已停用'
const TABLE_ENABLED = '已启用'

// 故障注入钩子：仅用于演示传播失败后的断点续跑，不做持久化，刷新页面自动解除。
const faultMap = new Map<string, string>()

export function armPropagationFault(objectCode: string, reason: string): void {
  faultMap.set(objectCode, reason)
}

export function clearPropagationFaults(): void {
  faultMap.clear()
}

export function listPropagationFaults(): { objectCode: string; reason: string }[] {
  return [...faultMap.entries()].map(([objectCode, reason]) => ({ objectCode, reason }))
}

function nowText(): string {
  return new Date().toLocaleString('zh-CN', { hour12: false })
}

function splitUpstream(value: unknown): string[] {
  return String(value ?? '')
    .split(/[,，]/)
    .map((item) => item.trim())
    .filter(Boolean)
}

function propagations(): PropagationRecord[] {
  return listCollection('propagations')
}

function syncBatches(): SyncBatch[] {
  return listCollection('syncBatches')
}

function findActivePropagation(channelCode: string): PropagationRecord | null {
  // 同一来源通道同时只保留一条生效传播记录，后到的停用操作直接复用它。
  const matched = propagations()
    .filter((record) => record.通道编号 === channelCode && record.记录状态 !== '已失效')
    .pop()
  return matched ?? null
}

function nextPropagationId(): number {
  const rows = propagations()
  return rows.reduce((max, row) => Math.max(max, row.id), 0) + 1
}

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(listRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

export function listSyncBatches(filters: { 原始表编号?: string; 批次状态?: string } = {}): SyncBatch[] {
  return syncBatches().filter((batch) => {
    if (filters.原始表编号 && batch.原始表编号 !== filters.原始表编号) {
      return false
    }
    if (filters.批次状态 && batch.批次状态 !== filters.批次状态) {
      return false
    }
    return true
  })
}

export function listPropagations(): PropagationRecord[] {
  return propagations()
}

/**
 * 来源通道停用的跨模块传播：
 * 1. 只阻断「待同步」批次对应的原始表，已落地批次沿用旧路径与旧状态；
 * 2. 依赖受影响原始表的清洗表一并置为不可同步，阻断原因写进清洗结果明细；
 * 3. 同通道并发停用只保留一条传播记录，重复调用直接复用结论；
 * 4. 逐项检查点落盘，传播失败后重试只从未处理/失败的表接着走。
 */
export function stopIngestChannel(channelId: number): ActionResult {
  const ingestRows = listRows(INGEST_KEY)
  const channelIndex = ingestRows.findIndex((row) => Number(row.id) === channelId)
  if (channelIndex < 0) {
    return { ok: false, message: `没有找到编号为 ${channelId} 的接入通道` }
  }
  const channel = ingestRows[channelIndex]
  const channelCode = String(channel.通道编号)

  let record = findActivePropagation(channelCode)
  if (record && record.记录状态 === '已完成') {
    // 通道仍是停用态、传播结论已存在：后到的停用操作直接复用，不再产生第二条记录。
    record.复用次数 += 1
    record.更新时间 = nowText()
    saveCollection('propagations', [...propagations()])
    if (String(channel.status) !== CHANNEL_STOPPED) {
      saveRows(INGEST_KEY, markChannelStopped(ingestRows, channelIndex))
    }
    return {
      ok: true,
      message: `通道 ${channelCode} 已停用，复用既有传播结论（第 ${record.复用次数} 次复用），共 ${record.影响明细.filter((item) => item.处理状态 === '已处理').length} 个对象已阻断`,
    }
  }

  if (!record) {
    record = buildPropagationRecord(channel)
    saveCollection('propagations', [...propagations(), record])
  }

  const outcome = processPropagation(record)
  saveRows(INGEST_KEY, markChannelStopped(ingestRows, channelIndex))

  if (outcome.failedTables.length > 0) {
    return {
      ok: true,
      message: `通道 ${channelCode} 已停用，但传播在 ${outcome.failedTables.length} 张表处中断：${outcome.failedTables.join('、')}；已处理结果保留，可重试续跑`,
      失败表: outcome.failedTables,
      传播记录编号: record.id,
    }
  }
  return {
    ok: true,
    message: `通道 ${channelCode} 已停用，传播完成：${outcome.processedCount} 个对象已阻断，无依赖的对象保持不变`,
    传播记录编号: record.id,
  }
}

/** 失败/中断后续跑：只处理传播记录里尚未成功处理的表，已处理项与跳过项不会重复改写。 */
export function retryPropagation(channelId: number): ActionResult {
  const ingestRows = listRows(INGEST_KEY)
  const channel = ingestRows.find((row) => Number(row.id) === channelId)
  if (!channel) {
    return { ok: false, message: `没有找到编号为 ${channelId} 的接入通道` }
  }
  const channelCode = String(channel.通道编号)
  const record = findActivePropagation(channelCode)
  if (!record) {
    return { ok: false, message: `通道 ${channelCode} 没有可重试的停用传播记录` }
  }
  const pending = record.影响明细.filter(
    (item) => item.处理状态 === '待处理' || item.处理状态 === '失败',
  )
  if (pending.length === 0) {
    return { ok: true, message: `通道 ${channelCode} 的传播记录没有待处理表，无需重试` }
  }
  const outcome = processPropagation(record)
  if (outcome.failedTables.length > 0) {
    return {
      ok: true,
      message: `重试在 ${outcome.failedTables.length} 张表处再次中断：${outcome.failedTables.join('、')}；其余表已续跑完成`,
      失败表: outcome.failedTables,
      传播记录编号: record.id,
    }
  }
  return {
    ok: true,
    message: `通道 ${channelCode} 传播重试完成，剩余 ${pending.length} 个对象已全部处理`,
    传播记录编号: record.id,
  }
}

/**
 * 通道重新启动：旧停用结论立即失效（新旧结论冲突时以来源通道当前状态为准），
 * 仅恢复该传播记录处理过的对象，其它模块没有依赖停用表的对象一律不动。
 */
export function restartIngestChannel(channelId: number): ActionResult {
  const ingestRows = listRows(INGEST_KEY)
  const channelIndex = ingestRows.findIndex((row) => Number(row.id) === channelId)
  if (channelIndex < 0) {
    return { ok: false, message: `没有找到编号为 ${channelId} 的接入通道` }
  }
  const channel = ingestRows[channelIndex]
  const channelCode = String(channel.通道编号)
  const record = findActivePropagation(channelCode)

  const restoredBronze = new Set<string>()
  const restoredSilver = new Set<string>()
  if (record) {
    for (const item of record.影响明细) {
      if (item.处理状态 !== '已处理') {
        continue
      }
      if (item.模块 === 'bronze') {
        restoredBronze.add(item.对象编号)
      } else {
        restoredSilver.add(item.对象编号)
      }
    }
    record.记录状态 = '已失效'
    record.结论 = `通道 ${channelCode} 已重新启动（${nowText()}），旧停用结论失效，同步状态以通道当前运行态为准`
    record.更新时间 = nowText()
    saveCollection('propagations', [...propagations()])
  }

  if (restoredBronze.size > 0) {
    const bronzeRows = listRows(BRONZE_KEY).map((row) =>
      restoredBronze.has(String(row.表编号))
        ? { ...row, status: TABLE_ENABLED, pending: false, abnormal: false, 可同步: true, 阻断原因: '' }
        : row,
    )
    saveRows(BRONZE_KEY, bronzeRows)
  }
  if (restoredSilver.size > 0) {
    const silverRows = listRows(SILVER_KEY).map((row) =>
      restoredSilver.has(String(row.表编号))
        ? { ...row, status: TABLE_ENABLED, pending: false, abnormal: false, 可同步: true, 阻断原因: '' }
        : row,
    )
    saveRows(SILVER_KEY, silverRows)
  }

  // 先前被阻断的待同步批次重新回到同步队列；已落地批次始终未被改写。
  const reopenedBatches = syncBatches().map((batch) =>
    batch.来源通道 === channelCode && batch.批次状态 === '已阻断'
      ? { ...batch, 批次状态: '待同步' as const }
      : batch,
  )
  saveCollection('syncBatches', reopenedBatches)

  const restarted: EntryRow = {
    ...channel,
    status: CHANNEL_RUNNING,
    pending: false,
    abnormal: false,
  }
  const nextIngest = [...ingestRows]
  nextIngest[channelIndex] = restarted
  saveRows(INGEST_KEY, nextIngest)

  return {
    ok: true,
    message: `通道 ${channelCode} 已恢复运行，旧停用结论失效；恢复原始表 ${restoredBronze.size} 张、清洗表 ${restoredSilver.size} 张，阻断批次重新入队`,
  }
}

/** 停用传播详情面板数据：被停用来源、受影响/仍可同步的原始表、跨模块清洗明细与批次口径。 */
export function getChannelPropagationDetail(channelId: number): ChannelPropagationDetail | null {
  const channel = listRows(INGEST_KEY).find((row) => Number(row.id) === channelId)
  if (!channel) {
    return null
  }
  const channelCode = String(channel.通道编号)
  const record = findActivePropagation(channelCode)
  const blockedBronzeCodes = new Set(
    record?.影响明细
      .filter((item) => item.模块 === 'bronze' && item.处理状态 === '已处理')
      .map((item) => item.对象编号) ?? [],
  )
  const bronzeTables = listRows(BRONZE_KEY)
    .filter((row) => String(row.来源通道) === channelCode)
    .map((row) => ({
      row,
      pendingBatches: syncBatches().filter(
        (batch) => batch.原始表编号 === String(row.表编号) && batch.批次状态 === '待同步',
      ),
      landedBatches: syncBatches().filter(
        (batch) => batch.原始表编号 === String(row.表编号) && batch.批次状态 === '已落地',
      ),
    }))
  const affectedSilver = listRows(SILVER_KEY).filter((row) =>
    splitUpstream(row.上游原始表).some((code) => blockedBronzeCodes.has(code)),
  )
  return { channel, record, bronzeTables, affectedSilver }
}

function markChannelStopped(rows: EntryRow[], index: number): EntryRow[] {
  const stopped: EntryRow = {
    ...rows[index],
    status: CHANNEL_STOPPED,
    pending: false,
    abnormal: true,
  }
  const next = [...rows]
  next[index] = stopped
  return next
}

/** 依据「待同步批次」口径预排传播影响明细：没有待同步批次的原始表只记跳过，不会被改写。 */
function buildPropagationRecord(channel: EntryRow): PropagationRecord {
  const channelCode = String(channel.通道编号)
  const bronzeRows = listRows(BRONZE_KEY)
  const channelBronze = bronzeRows.filter((row) => String(row.来源通道) === channelCode)
  const items: PropagationItem[] = []
  const affectedBronzeCodes: string[] = []

  for (const bronze of channelBronze) {
    const code = String(bronze.表编号)
    const path = String(bronze.目标路径 ?? '')
    const pending = syncBatches().filter(
      (batch) => batch.原始表编号 === code && batch.批次状态 === '待同步',
    )
    if (pending.length === 0) {
      items.push({
        模块: 'bronze',
        对象编号: code,
        对象名称: code,
        处理状态: '跳过',
        关联路径: path,
        阻断原因: '无待同步批次：已落地批次沿用当时同步路径与旧状态，本次规则不改写',
      })
      continue
    }
    affectedBronzeCodes.push(code)
    items.push({
      模块: 'bronze',
      对象编号: code,
      对象名称: code,
      处理状态: '待处理',
      关联路径: path,
      阻断原因: `来源通道 ${channelCode} 已停用，待同步批次 ${pending
        .map((batch) => batch.批次编号)
        .join('、')} 被阻断，目标路径 ${path} 已从上游同步队列摘除`,
    })
  }

  for (const silver of listRows(SILVER_KEY)) {
    const upstream = splitUpstream(silver.上游原始表)
    const hit = upstream.filter((code) => affectedBronzeCodes.includes(code))
    if (hit.length === 0) {
      continue
    }
    items.push({
      模块: 'silver',
      对象编号: String(silver.表编号),
      对象名称: String(silver.表编号),
      处理状态: '待处理',
      关联路径: String(silver.输出路径 ?? ''),
      阻断原因: `上游原始表 ${hit.join('、')} 随来源通道 ${channelCode} 停用而不可同步，清洗作业读取路径已阻断，输出路径 ${String(
        silver.输出路径 ?? '',
      )} 暂停生成`,
    })
  }

  return {
    id: nextPropagationId(),
    通道编号: channelCode,
    通道名称: String(channel.源端类型 ?? channelCode),
    记录状态: '进行中',
    结论: `来源通道 ${channelCode} 停用传播，待处理对象 ${items.filter((item) => item.处理状态 === '待处理').length} 个`,
    发起时间: nowText(),
    更新时间: nowText(),
    复用次数: 0,
    失败表: [],
    影响明细: items,
  }
}

/** 逐项推进传播：每处理完一张表就落一次检查点，故障注入命中即中断并保留现场。 */
function processPropagation(record: PropagationRecord): { processedCount: number; failedTables: string[] } {
  let processedCount = 0
  const failedTables: string[] = []

  for (const item of record.影响明细) {
    if (item.处理状态 === '已处理' || item.处理状态 === '跳过') {
      continue
    }
    const faultReason = faultMap.get(item.对象编号)
    if (faultReason) {
      item.处理状态 = '失败'
      item.失败说明 = faultReason
      failedTables.push(item.对象编号)
      record.失败表 = [...new Set([...record.失败表, ...failedTables])]
      record.记录状态 = '失败'
      record.结论 = `传播中断于 ${item.对象编号}：${faultReason}；已落检查点，重试从未处理表接着走`
      record.更新时间 = nowText()
      saveCollection('propagations', [...propagations()])
      return { processedCount, failedTables }
    }

    if (item.模块 === 'bronze') {
      applyBronzeBlock(item)
    } else {
      applySilverBlock(item)
    }
    item.处理状态 = '已处理'
    item.失败说明 = ''
    processedCount += 1
    record.更新时间 = nowText()
    // 每张表处理完立即落盘：页面中断或再次触发时，已处理表不会被重复改写。
    saveCollection('propagations', [...propagations()])
  }

  record.失败表 = record.影响明细.filter((item) => item.处理状态 === '失败').map((item) => item.对象编号)
  record.记录状态 = '失败'
  const remaining = record.影响明细.filter(
    (item) => item.处理状态 === '待处理' || item.处理状态 === '失败',
  )
  if (remaining.length === 0) {
    record.记录状态 = '已完成'
    record.结论 = `来源通道 ${record.通道编号} 停用传播完成：阻断原始表 ${
      record.影响明细.filter((item) => item.模块 === 'bronze' && item.处理状态 === '已处理').length
    } 张、清洗表 ${
      record.影响明细.filter((item) => item.模块 === 'silver' && item.处理状态 === '已处理').length
    } 张；无待同步批次的对象保持原状态`
  }
  record.更新时间 = nowText()
  saveCollection('propagations', [...propagations()])
  return { processedCount, failedTables }
}

function applyBronzeBlock(item: PropagationItem): void {
  const bronzeRows = listRows(BRONZE_KEY)
  const next = bronzeRows.map((row) =>
    String(row.表编号) === item.对象编号
      ? {
          ...row,
          status: TABLE_DISABLED,
          pending: false,
          abnormal: true,
          可同步: false,
          阻断原因: item.阻断原因,
        }
      : row,
  )
  saveRows(BRONZE_KEY, next)

  // 只阻断待同步批次；已落地批次的同步路径与状态保持落地时的口径不动。
  const batches = syncBatches().map((batch) =>
    batch.原始表编号 === item.对象编号 && batch.批次状态 === '待同步'
      ? { ...batch, 批次状态: '已阻断' as const }
      : batch,
  )
  saveCollection('syncBatches', batches)
}

function applySilverBlock(item: PropagationItem): void {
  const silverRows = listRows(SILVER_KEY)
  const next = silverRows.map((row) =>
    String(row.表编号) === item.对象编号
      ? {
          ...row,
          status: TABLE_DISABLED,
          pending: false,
          abnormal: true,
          可同步: false,
          阻断原因: item.阻断原因,
        }
      : row,
  )
  saveRows(SILVER_KEY, next)
}

export function runAction(key: string, id: number, action: string): ActionResult {
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  // 接入通道的启停走跨模块传播链路，不走通用的单条状态改写。
  if (key === INGEST_KEY && action === '停止接入') {
    return stopIngestChannel(id)
  }
  if (key === INGEST_KEY && action === '启动接入') {
    return restartIngestChannel(id)
  }
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const current = String(rows[index].status)
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: target !== lastStatus,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  // 重置链路相关模块时，同步批次与传播结论一并回到种子口径，避免清单与集合状态错位。
  if (key === INGEST_KEY || key === BRONZE_KEY || key === SILVER_KEY) {
    resetCollections()
    clearPropagationFaults()
  }
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of listRows(key)) {
    const values = [row.id, ...meta.fields.map((field) => renderCell(row[field])), row.status]
    lines.push(values.join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `﻿${lines.join('\n')}` }
}

function renderCell(value: unknown): string {
  if (typeof value === 'boolean') {
    return value ? '是' : '否'
  }
  return String(value ?? '')
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}
