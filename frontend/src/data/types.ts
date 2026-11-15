/** 纯前端数据层的公共类型：与全栈版后端返回的结构保持一致，换回后端时页面不用改。 */

export type EntryRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  [field: string]: string | number | boolean
}

export type ModuleMeta = {
  key: string
  name: string
  entity: string
  desc: string
  fields: string[]
  statuses: string[]
  actions: string[]
  actionTargets: Record<string, string>
  metrics: string[]
}

export type PageResult = {
  items: EntryRow[]
  total: number
  page: number
  size: number
}

export type ActionResult = {
  ok: boolean
  message: string
  失败表?: string[]
  传播记录编号?: number
}

export type OverviewResult = {
  cards: { label: string; value: number }[]
  modules: { name: string; created: number; pending: number; abnormal: number }[]
}

/** 同步批次：落地时固化当时的同步路径，来源停用时只阻断待同步批次，已落地批次沿用旧路径与旧状态。 */
export type SyncBatch = {
  id: number
  批次编号: string
  原始表编号: string
  来源通道: string
  同步路径: string
  批次状态: '待同步' | '已落地' | '已阻断'
  落地时间: string
}

/** 传播影响明细的逐项处理状态，失败重试时只 picked 待处理项接着走。 */
export type PropagationItemStatus = '待处理' | '已处理' | '失败' | '跳过'

export type PropagationItem = {
  模块: 'bronze' | 'silver'
  对象编号: string
  对象名称: string
  处理状态: PropagationItemStatus
  关联路径: string
  阻断原因: string
  失败说明?: string
}

/** 来源通道停用传播记录：同一通道同时只允许一条生效记录，重复停用直接复用。 */
export type PropagationRecord = {
  id: number
  通道编号: string
  通道名称: string
  记录状态: '进行中' | '已完成' | '失败' | '已失效'
  结论: string
  发起时间: string
  更新时间: string
  复用次数: number
  失败表: string[]
  影响明细: PropagationItem[]
}

export type ChannelPropagationDetail = {
  channel: EntryRow
  record: PropagationRecord | null
  bronzeTables: {
    row: EntryRow
    pendingBatches: SyncBatch[]
    landedBatches: SyncBatch[]
  }[]
  affectedSilver: EntryRow[]
}
