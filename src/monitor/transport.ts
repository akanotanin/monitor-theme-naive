import type { HistoryWindow, MonitorFrame, MonitorNode, SiteInfo } from './types'
import type { PingRecord, PingTaskSummary, StatusRecord } from '@/types/komari'
import { mapNode } from './mapping'

/**
 * 极简探针传输层
 * 把 Monitor 的 REST / WebSocket 接口翻译成主题原本依赖的 Komari RPC2 数据
 */

/** 与 vite 的 VITE_API_BASE 保持一致，开发时由 dev server 代理到 MONITOR_HUB */
const API_BASE = (import.meta.env.VITE_API_BASE || '/api').replace(/\/$/, '')

/** 节点快照缓存，避免同一帧内重复请求 */
const SNAPSHOT_TTL = 1500
/** 历史窗口缓存：图表按 dataUpdateInterval 轮询，粒度不会比 1 分钟更细 */
const HISTORY_TTL = 15000
/** 旧 hub（没有 history_days）的历史窗口上限（小时）：匿名 7 天、登录 90 天 */
const PUBLIC_HOURS = 168
const ADMIN_HOURS = 2160

let snapshot: MonitorNode[] = []
let admin = false
let received = 0
let pending: Promise<MonitorNode[]> | undefined
/** hub 的保留天数（/api/me 的 history_days），旧 hub 为 null */
let historyDays: number | null = null
const historyCache = new Map<string, { time: number, promise: Promise<HistoryWindow> }>()

export class MonitorRequestError extends Error {
  status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'MonitorRequestError'
    this.status = status
  }
}

/** 请求极简探针接口；站点未开放状态页时跳到后台登录 */
export async function request<T>(path: string, signal?: AbortSignal): Promise<T> {
  const timeout = AbortSignal.timeout(15000)
  const response = await fetch(`${API_BASE}${path}`, {
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    credentials: 'same-origin',
    headers: { accept: 'application/json' },
  })
  if (response.status === 401) {
    location.assign('/admin/')
    throw new MonitorRequestError(401, '需要登录极简探针后台')
  }
  if (!response.ok)
    throw new MonitorRequestError(response.status, `极简探针接口 ${path} 返回 ${response.status}`)
  return await response.json() as T
}

/** 记录一帧节点快照（来自 /api/nodes 或 /api/ws） */
export function acceptFrame(frame: Partial<MonitorFrame> | null | undefined): MonitorNode[] {
  if (!frame || !Array.isArray(frame.nodes))
    throw new MonitorRequestError(0, '无效的节点快照')
  snapshot = frame.nodes
  admin = Boolean(frame.admin)
  received = Date.now()
  return frame.nodes
}

/** 读取节点列表（带 1.5 秒缓存） */
export async function readNodes(signal?: AbortSignal): Promise<MonitorNode[]> {
  if (Date.now() - received < SNAPSHOT_TTL)
    return snapshot
  pending ??= request<MonitorFrame>('/nodes', signal)
    .then(frame => acceptFrame(frame))
    .finally(() => { pending = undefined })
  return await pending
}

/**
 * 丢掉快照缓存与在途请求：页面切到后台再回到前台时调用，
 * 回前台那一次必然重新取一份，而不是拿切走之前的旧快照
 */
export function resetSnapshot(): void {
  received = 0
  pending = undefined
}

/** 当前访客是否为已登录管理员（由 /api/nodes 的 admin 字段给出） */
export function isAdmin(): boolean {
  return admin
}

/** 历史窗口上限（小时）：hub 1.3.2 起就是保留天数本身，匿名与登录相同 */
export function preserveHours(): number {
  if (historyDays !== null)
    return Math.max(1, Math.round(historyDays * 24))
  return admin ? ADMIN_HOURS : PUBLIC_HOURS
}

/** 把节点列表映射成 Komari 的 clients / statuses 字典 */
export function mappedNodes(nodes: MonitorNode[]) {
  const entries = nodes.map(mapNode)
  return {
    clients: Object.fromEntries(entries.map(n => [n.client.uuid, n.client])),
    statuses: Object.fromEntries(entries.map(n => [n.client.uuid, n.status])),
  }
}

/** 站点名称与登录状态；顺手记下 hub 的保留天数，供历史窗口选择器使用 */
export async function site(): Promise<SiteInfo> {
  const info = await request<SiteInfo>('/me')
  if (typeof info.history_days === 'number' && Number.isFinite(info.history_days) && info.history_days > 0)
    historyDays = info.history_days
  return info
}

/**
 * 历史窗口：Monitor 按 hours + points 自动分桶
 * points 决定桶宽，1 分钟一个采样是 Hub 能给出的最细粒度
 */
async function history(id: string, hours: number, series: 'metrics' | 'ping', points = 600): Promise<HistoryWindow> {
  if (!/^\d+$/.test(id))
    throw new MonitorRequestError(0, '无效的节点编号')
  const path = `/nodes/${id}/metrics?${new URLSearchParams({ hours: String(hours), points: String(points), series })}`
  const cached = historyCache.get(path)
  if (cached && Date.now() - cached.time < HISTORY_TTL)
    return await cached.promise
  const promise = request<HistoryWindow>(path).catch((error) => {
    historyCache.delete(path)
    throw error
  })
  if (historyCache.size > 100)
    historyCache.clear()
  historyCache.set(path, { time: Date.now(), promise })
  return await promise
}

/** 限制并发，避免一个放大的图表把 Hub 的连接池占满 */
async function mapLimited<T, R>(items: T[], worker: (item: T) => Promise<R>): Promise<R[]> {
  const output: R[] = []
  let next = 0
  await Promise.all(Array.from({ length: Math.min(4, items.length) }, async () => {
    while (next < items.length) {
      const index = next++
      output[index] = await worker(items[index]!)
    }
  }))
  return output
}

/** 窗口点数：短窗口按分钟取点，长窗口最多 600 点 */
function windowPoints(hours: number): number {
  return Math.max(60, Math.min(600, Math.round(hours * 60)))
}

/** 一条历史负载记录（湿度/负载/进程等 Monitor 不记录的字段保持 undefined） */
function loadPoint(node: MonitorNode, point: HistoryWindow['metrics'][number]): StatusRecord {
  return {
    client: String(node.id),
    time: new Date(point.ts * 1000).toISOString(),
    cpu: point.cpu,
    ram: point.mem_used,
    ram_total: node.metrics?.mem_total ?? node.mem_total,
    disk: point.disk_used,
    disk_total: node.metrics?.disk_total ?? node.disk_total,
    net_in: point.net_rx,
    net_out: point.net_tx,
  }
}

/**
 * 历史记录，兼容主题用到的三种入口
 * - 负载：records 以节点 uuid 为键（common:getRecords / public:getRecordsByUUID）
 * - 最近状态：records 为平铺数组（common:getNodeRecentStatus）
 * - 延迟：records + tasks（public:getPingRecords）
 */
export async function records(params: Record<string, unknown>, ping = false) {
  const nodes = await readNodes()
  const wanted = params.uuid ? nodes.filter(n => String(n.id) === String(params.uuid)) : nodes
  const hours = Number(params.hours ?? 1) || 1
  const points = windowPoints(hours)

  const perNode = await mapLimited(wanted, async (node) => {
    const h = await history(String(node.id), hours, ping ? 'ping' : 'metrics', points)
    if (ping) {
      const list = h.ping
        .filter(p => !params.task_id || String(p.task_id) === String(params.task_id))
        .map<PingRecord>(p => ({
          client: String(node.id),
          task_id: Number(p.task_id),
          time: new Date(p.ts * 1000).toISOString(),
          // 负值表示超时，与 Komari 的约定一致
          value: typeof p.latency === 'number' && Number.isFinite(p.latency) ? p.latency : -1,
        }))
      const tasks = Object.entries(h.probes).map<PingTaskSummary>(([id, name]) => {
        const values = h.ping
          .filter(p => String(p.task_id) === id && typeof p.latency === 'number')
          .map(p => p.latency as number)
        return {
          id: Number(id),
          name,
          type: 'icmp',
          interval: 60,
          default_on: false,
          clients: [String(node.id)],
          loss: typeof h.loss?.[id] === 'number' ? h.loss[id] : 0,
          avg: values.length ? values.reduce((a, b) => a + b, 0) / values.length : undefined,
          min: values.length ? Math.min(...values) : undefined,
          max: values.length ? Math.max(...values) : undefined,
        }
      })
      return { id: String(node.id), records: list, tasks }
    }
    return {
      id: String(node.id),
      records: h.metrics.map(point => loadPoint(node, point)),
      tasks: [] as PingTaskSummary[],
    }
  })

  if (ping) {
    const flatRecords = perNode.flatMap(n => n.records as PingRecord[])
    const tasks = new Map<number, PingTaskSummary>()
    for (const task of perNode.flatMap(n => n.tasks)) {
      const previous = tasks.get(task.id)
      tasks.set(task.id, {
        ...task,
        clients: [...new Set([...(previous?.clients ?? []), ...(task.clients ?? [])])],
      })
    }
    return { records: flatRecords, count: flatRecords.length, tasks: [...tasks.values()] }
  }

  const keyed: Record<string, StatusRecord[]> = {}
  for (const entry of perNode)
    keyed[entry.id] = entry.records as StatusRecord[]
  const count = Object.values(keyed).reduce((total, list) => total + list.length, 0)
  return { records: keyed, count }
}

/** 最近 1 小时的状态记录（实时图表用），并把 Hub 当前采样追加在末位 */
async function recentStatus(nodeId: string) {
  const nodes = await readNodes()
  const node = nodes.find(n => String(n.id) === stringify(nodeId))
  if (!node)
    return { count: 0, records: [] as StatusRecord[] }
  const h = await history(String(node.id), 1, 'metrics', 60)
  const list = h.metrics.map(point => loadPoint(node, point))
  const live = node.metrics
  if (node.online && live) {
    const current: StatusRecord = {
      client: String(node.id),
      time: new Date().toISOString(),
      cpu: live.cpu,
      ram: live.mem_used,
      ram_total: live.mem_total,
      swap: live.swap_used,
      swap_total: live.swap_total,
      load: live.load?.[0],
      load5: live.load?.[1],
      load15: live.load?.[2],
      disk: live.disk_used,
      disk_total: live.disk_total,
      net_in: live.net_rx,
      net_out: live.net_tx,
      net_total_up: live.month_tx,
      net_total_down: live.month_rx,
      process: live.procs,
      connections: live.tcp,
      connections_udp: live.udp,
    }
    const last = list.at(-1)
    // 同一个时间桶内不重复追加，避免出现两条时间相同的点
    if (!last || Date.parse(last.time) < Date.parse(current.time) - 1000)
      list.push(current)
    else
      list[list.length - 1] = current
  }
  return { count: list.length, records: list }
}

function stringify(value: unknown): string {
  return value === null || value === undefined ? '' : String(value)
}

/**
 * 把 Komari RPC2 方法名翻译成极简探针接口调用
 * 极简探针不提供的能力抛 -32601，主题侧会显示为「不支持」而不是假数据
 */
export async function dispatch(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
  switch (method) {
    case 'rpc.ping':
      await readNodes()
      return 'pong'
    case 'common:getNodes':
      return mappedNodes(await readNodes()).clients
    case 'common:getNodesLatestStatus': {
      const { statuses } = mappedNodes(await readNodes())
      if (params.uuid)
        return { [stringify(params.uuid)]: statuses[stringify(params.uuid)] }
      if (Array.isArray(params.uuids)) {
        const picked: Record<string, unknown> = {}
        for (const uuid of params.uuids)
          picked[stringify(uuid)] = statuses[stringify(uuid)]
        return picked
      }
      return statuses
    }
    case 'common:getNodeRecentStatus':
      return await recentStatus(stringify(params.uuid))
    case 'common:getRecords':
      return await records(params, params.type === 'ping')
    case 'public:getPingRecords':
      return await records(params, true)
    case 'public:getVersion': {
      // 版本接口只对管理员开放，匿名访客留空，页脚会隐藏这一项
      if (!admin)
        return { version: '', hash: '' }
      try {
        const info = await request<Record<string, unknown>>('/version')
        return { version: typeof info?.version === 'string' ? info.version : '', hash: '' }
      }
      catch {
        return { version: '', hash: '' }
      }
    }
    default:
      throw new MonitorRequestError(0, `极简探针不提供此能力：${method}`)
  }
}

/** 实时连接状态 */
export type LiveState = 'connecting' | 'connected' | 'disconnected' | 'reconnecting'

export interface LiveHandle {
  close: () => void
}

/**
 * hub 1.4.0 起可以按 gzip 推帧（每帧 110 KB → 15 KB）：请求参数带上 gzip，
 * 帧就走二进制。站长登录着打开公开页、或 hub 是旧版时仍推文本帧，两种都要能收。
 */
const GZIP = typeof DecompressionStream === 'function' ? '?gzip' : ''

/** 把一帧读成文本：gzip 帧是二进制，其余仍是文本 */
async function frameText(data: string | Blob): Promise<string> {
  if (typeof data === 'string')
    return data
  return await new Response(data.stream().pipeThrough(new DecompressionStream('gzip'))).text()
}

/**
 * 订阅 /api/ws 的节点快照
 * 连接失败会自动重连，主题侧另有轮询兜底，因此这里不做无限重试
 */
export function connectLive(
  onNodes: (nodes: MonitorNode[]) => void,
  onState: (state: LiveState) => void,
  options: { retryInterval?: number, maxRetries?: number } = {},
): LiveHandle {
  const retryInterval = options.retryInterval ?? 3000
  const maxRetries = options.maxRetries ?? 5
  let socket: WebSocket | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  let attempts = 0
  let closed = false

  const url = new URL(`${API_BASE}/ws${GZIP}`, location.href)
  url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'

  const scheduleRetry = () => {
    if (closed)
      return
    if (attempts >= maxRetries) {
      onState('disconnected')
      return
    }
    attempts += 1
    onState('reconnecting')
    timer = setTimeout(connect, retryInterval)
  }

  function connect(): void {
    if (closed)
      return
    onState('connecting')
    try {
      socket = new WebSocket(url)
    }
    catch {
      scheduleRetry()
      return
    }
    // gzip 帧走二进制；文本帧（旧 hub、或站长登录着看的完整视图）仍是字符串
    socket.binaryType = 'blob'
    socket.onopen = () => {
      attempts = 0
      onState('connected')
    }
    // 按到达顺序解码：gzip 帧是异步解开的，谁先读完不一定
    let decoded = Promise.resolve()
    socket.onmessage = (event) => {
      const source = socket
      decoded = decoded
        .then(async () => {
          const frame = JSON.parse(await frameText(event.data as string | Blob)) as MonitorFrame
          // 这一帧可能在连接被换掉之后才解开，那它描述的不是当前这一刻
          if (source !== socket)
            return
          if (Array.isArray(frame?.nodes)) {
            acceptFrame(frame)
            onNodes(frame.nodes)
          }
        })
        .catch(() => {
          // 忽略无法解析的帧
        })
    }
    socket.onerror = () => {
      onState('reconnecting')
    }
    socket.onclose = () => {
      socket = null
      if (!closed)
        scheduleRetry()
    }
  }

  connect()

  return {
    close() {
      closed = true
      if (timer)
        clearTimeout(timer)
      timer = null
      if (socket) {
        socket.onopen = null
        socket.onmessage = null
        socket.onerror = null
        socket.onclose = null
        socket.close()
        socket = null
      }
    },
  }
}
