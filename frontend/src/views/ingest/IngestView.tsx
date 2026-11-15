import { useCallback, useEffect, useMemo, useState } from 'react'

import {
  armPropagationFault,
  clearPropagationFaults,
  downloadEntries,
  getChannelPropagationDetail,
  listEntries,
  listPropagationFaults,
  moduleMeta,
  retryPropagation,
  runAction as applyAction,
} from '@/api/local-service'
import type { ChannelPropagationDetail, EntryRow } from '@/data/types'

const meta = moduleMeta('ingest')
const columns = [
  "通道编号",
  "源端类型",
  "连接参数",
  "接入模式",
  "批次大小",
  "校验规则",
  "异常处理",
  "通道负责人"
]
const actions = [
  "提交校验",
  "启动接入",
  "停止接入"
]
const statuses = [
  "草稿",
  "待校验",
  "运行中",
  "已停止"
]
const stats = [
  { label: "接入通道总数", value: 0 },
  { label: "运行中通道", value: 0 },
  { label: "待校验通道", value: 0 }
]

export default function IngestView() {
  const [rows, setRows] = useState<EntryRow[]>([])
  const [total, setTotal] = useState(0)
  const [errorMessage, setErrorMessage] = useState('')
  const [filters, setFilters] = useState<Record<string, string>>({})
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [detail, setDetail] = useState<ChannelPropagationDetail | null>(null)
  const [faultTarget, setFaultTarget] = useState('')
  const [faults, setFaults] = useState(() => listPropagationFaults())
  const filterFields = useMemo(() => columns.slice(0, 3), [])

  const refreshDetail = useCallback((id: number | null) => {
    if (id === null) {
      setDetail(null)
      return
    }
    setDetail(getChannelPropagationDetail(id))
  }, [])

  const reload = useCallback(() => {
    setErrorMessage('')
    try {
      const payload = listEntries(meta.key, filters)
      setRows(payload.items)
      setTotal(payload.total)
      if (selectedId === null && payload.items.length > 0) {
        const firstId = Number(payload.items[0].id)
        setSelectedId(firstId)
        refreshDetail(firstId)
      } else if (selectedId !== null) {
        refreshDetail(selectedId)
      }
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : '多源接入列表读取失败')
    }
  }, [filters, refreshDetail, selectedId])

  useEffect(() => {
    reload()
  }, [reload])

  function runAction(action: string, row: EntryRow) {
    setErrorMessage('')
    const result = applyAction(meta.key, Number(row.id), action)
    if (!result.ok) {
      setErrorMessage(result.message)
      return
    }
    setErrorMessage(result.message)
    if (action === '停止接入' || action === '启动接入') {
      setSelectedId(Number(row.id))
    }
    reload()
  }

  function selectChannel(row: EntryRow) {
    const id = Number(row.id)
    setSelectedId(id)
    refreshDetail(id)
  }

  function handleRetry() {
    if (selectedId === null) {
      return
    }
    const result = retryPropagation(selectedId)
    setErrorMessage(result.message)
    setFaults(listPropagationFaults())
    reload()
  }

  function handleArmFault() {
    const code = faultTarget.trim()
    if (!code) {
      setErrorMessage('请输入要注入故障的对象编号，例如 BRON-0001 或 SILV-0002')
      return
    }
    armPropagationFault(code, '模拟传播写入失败：本地存储写入被故障注入中断')
    setFaultTarget('')
    setFaults(listPropagationFaults())
    setErrorMessage(`已对 ${code} 注入传播故障，下一次停用/重试会在该表处中断`)
  }

  function handleClearFaults() {
    clearPropagationFaults()
    setFaults([])
    setErrorMessage('已清除全部故障注入')
  }

  const stoppedChannels = rows.filter((row) => String(row.status) === '已停止')
  const syncableTables = detail?.bronzeTables.filter((item) => item.row.可同步 !== false) ?? []
  const blockedTables = detail?.bronzeTables.filter((item) => item.row.可同步 === false) ?? []
  const recordItems = detail?.record?.影响明细 ?? []
  const failedItems = recordItems.filter((item) => item.处理状态 === '失败')
  const skippedItems = recordItems.filter((item) => item.处理状态 === '跳过')

  return (
    <section className="page" data-module="ingest">
      <header className="page-head">
        <div>
          <h2>多源接入管理</h2>
          <p className="page-desc">维护多源接入通道的输入、执行约束与结果记录。停用通道会沿 来源通道 → 原始表 → 清洗表 链路传播，只阻断待同步批次，已落地批次沿用旧路径与旧状态。</p>
        </div>
        <div className="page-actions">
          <button className="btn primary" type="button" onClick={() => setErrorMessage('接入通道登记入口尚未接入审批流')}>
            登记接入通道
          </button>
          <button className="btn" type="button" onClick={() => downloadEntries(meta.key)}>
            导出多源接入清单
          </button>
        </div>
      </header>

      <div className="stat-row">
        {stats.map((item) => (
          <article key={item.label} className="stat-card">
            <span className="stat-label">{item.label}</span>
            <strong className="stat-value">{item.value}</strong>
          </article>
        ))}
      </div>

      <p className="status-legend">
        {statuses.map((status: string) => (
          <span key={status} className="legend-item">
            {status}：{rows.filter((row) => String(row.status) === status).length}
          </span>
        ))}
      </p>

      <form className="filter-bar" onSubmit={(event) => { event.preventDefault(); reload() }}>
        {filterFields.map((field) => (
          <label key={field} className="filter-item">
            <span>{field}</span>
            <input
              value={filters[field] ?? ''}
              placeholder={`按${field}检索`}
              onChange={(event) => setFilters((prev) => ({ ...prev, [field]: event.target.value }))}
            />
          </label>
        ))}
        <button className="btn" type="submit">查询</button>
        <button className="btn ghost" type="button" onClick={() => setFilters({})}>重置条件</button>
      </form>

      <table className="data-table">
        <thead>
          <tr>
            {columns.map((column) => <th key={column}>{column}</th>)}
            <th>当前状态</th>
            <th>可执行动作</th>
            <th>传播详情</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={String(row.id)} className={Number(row.id) === selectedId ? 'row-selected' : undefined}>
              {columns.map((column) => <td key={column}>{row[column] ?? '—'}</td>)}
              <td>
                <span className={String(row.status) === '已停止' ? 'badge badge-off' : 'badge badge-on'}>
                  {row.status}
                </span>
              </td>
              <td className="row-actions">
                {actions.map((action) => (
                  <button key={action} className="link" type="button" onClick={() => runAction(action, row)}>
                    {action}
                  </button>
                ))}
              </td>
              <td>
                <button className="link" type="button" onClick={() => selectChannel(row)}>
                  查看停用传播
                </button>
              </td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td className="empty-state" colSpan={columns.length + 3}>暂无多源接入数据，可先登记接入通道</td>
            </tr>
          )}
        </tbody>
      </table>

      <div className="prop-panel">
        <div className="prop-panel-head">
          <h3>停用传播详情{detail ? `：${String(detail.channel.通道编号)}（${String(detail.channel.源端类型)}）` : ''}</h3>
          <span className="prop-panel-hint">同一来源并发停用只保留一条传播记录，后到操作直接复用结论</span>
        </div>

        {!detail && (
          <p className="empty-state">暂无选中通道：请在上方列表点击「查看停用传播」选择一个来源通道。</p>
        )}

        {detail && (
          <>
            <section className="prop-section">
              <h4>被停用的来源</h4>
              {stoppedChannels.length === 0 ? (
                <p className="empty-state">当前没有被停用的来源通道，全部通道处于可接入状态。</p>
              ) : (
                <ul className="prop-list">
                  {stoppedChannels.map((channel) => (
                    <li key={String(channel.id)}>
                      <span className="badge badge-off">{String(channel.status)}</span>
                      <strong>{String(channel.通道编号)}</strong>
                      <span className="muted">{String(channel.源端类型)} · 负责人 {String(channel.通道负责人)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="prop-section">
              <h4>仍可同步的原始表（{syncableTables.length}）</h4>
              {syncableTables.length === 0 ? (
                <p className="empty-state">该通道下没有仍可同步的原始表，全部已被阻断或尚无登记。</p>
              ) : (
                <table className="data-table inner-table">
                  <thead>
                    <tr><th>表编号</th><th>目标路径</th><th>待同步批次</th><th>已落地批次</th><th>同步状态</th></tr>
                  </thead>
                  <tbody>
                    {syncableTables.map(({ row, pendingBatches, landedBatches }) => (
                      <tr key={String(row.id)}>
                        <td>{String(row.表编号)}</td>
                        <td>{String(row.目标路径)}</td>
                        <td>{pendingBatches.length}</td>
                        <td>{landedBatches.length}</td>
                        <td><span className="badge badge-on">可同步</span></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>

            <section className="prop-section">
              <h4>已阻断的原始表与清洗明细（{blockedTables.length} 张原始表，{detail.affectedSilver.length} 张清洗表）</h4>
              {recordItems.length === 0 ? (
                <p className="empty-state">该通道尚未发起过停用传播，暂无阻断明细。</p>
              ) : (
                <table className="data-table inner-table">
                  <thead>
                    <tr><th>模块</th><th>对象编号</th><th>关联路径</th><th>处理状态</th><th>阻断原因</th></tr>
                  </thead>
                  <tbody>
                    {recordItems.map((item) => (
                      <tr key={`${item.模块}-${item.对象编号}`}>
                        <td>{item.模块 === 'bronze' ? '原始层' : '清洗层'}</td>
                        <td>{item.对象编号}</td>
                        <td>{item.关联路径 || '—'}</td>
                        <td>
                          <span className={`badge ${item.处理状态 === '已处理' ? 'badge-off' : item.处理状态 === '失败' ? 'badge-fault' : 'badge-muted'}`}>
                            {item.处理状态}
                          </span>
                          {item.失败说明 && <p className="fault-text">{item.失败说明}</p>}
                        </td>
                        <td className="reason-cell">{item.阻断原因 || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              {skippedItems.length > 0 && (
                <p className="prop-note">其中 {skippedItems.length} 张原始表没有待同步批次，已落地批次继续沿用旧路径与旧状态，本次规则不改写。</p>
              )}
            </section>

            <section className="prop-section">
              <h4>传播记录与重试</h4>
              {!detail.record ? (
                <p className="empty-state">暂无传播记录：停用该通道后会在此生成一条唯一的传播结论。</p>
              ) : (
                <div className="record-box">
                  <p>
                    记录编号 #{detail.record.id} ·
                    状态 <span className={`badge ${detail.record.记录状态 === '已完成' ? 'badge-off' : detail.record.记录状态 === '失败' ? 'badge-fault' : 'badge-muted'}`}>{detail.record.记录状态}</span>
                    · 复用次数 {detail.record.复用次数} · 发起 {detail.record.发起时间} · 更新 {detail.record.更新时间}
                  </p>
                  <p className="muted">{detail.record.结论}</p>
                  {failedItems.length > 0 && (
                    <>
                      <p className="fault-text">失败表：{failedItems.map((item) => item.对象编号).join('、')}（检查点已保留，重试只从未处理的表接着走）</p>
                      <button className="btn primary" type="button" onClick={handleRetry}>重试失败传播</button>
                    </>
                  )}
                </div>
              )}
            </section>

            <section className="prop-section">
              <h4>故障注入（仅用于演示中断续跑，不持久化）</h4>
              <div className="filter-bar">
                <label className="filter-item">
                  <span>故障对象编号</span>
                  <input
                    value={faultTarget}
                    placeholder="如 BRON-0002 / SILV-0001"
                    onChange={(event) => setFaultTarget(event.target.value)}
                  />
                </label>
                <button className="btn" type="button" onClick={handleArmFault}>注入故障</button>
                <button className="btn ghost" type="button" onClick={handleClearFaults}>清除故障</button>
              </div>
              {faults.length === 0 ? (
                <p className="empty-state">当前没有故障注入，停用传播会一次处理完所有受影响表。</p>
              ) : (
                <ul className="prop-list">
                  {faults.map((fault) => (
                    <li key={fault.objectCode}>
                      <span className="badge badge-fault">待触发</span>
                      <strong>{fault.objectCode}</strong>
                      <span className="muted">{fault.reason}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </>
        )}
      </div>

      <footer className="page-foot">
        <span>共 {total} 条多源接入记录</span>
        {errorMessage && <span className="error-text">{errorMessage}</span>}
      </footer>
    </section>
  )
}
