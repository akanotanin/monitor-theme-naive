/**
 * 极简探针（Monitor）公开接口的数据结构
 * 对应 GET /api/nodes、GET /api/ws、GET /api/nodes/{id}/metrics、GET /api/me
 */

/** 节点实时指标 */
export interface MonitorMetrics {
  uptime: number
  cpu: number
  /** 1 / 5 / 15 分钟平均负载 */
  load: number[]
  mem_total: number
  mem_used: number
  swap_total: number
  swap_used: number
  disk_total: number
  disk_used: number
  /** 当前上下行速率（字节/秒） */
  net_rx: number
  net_tx: number
  /** 生命周期累计流量 */
  total_rx: number
  total_tx: number
  /** 本计费周期流量 */
  month_rx: number
  month_tx: number
  tcp: number
  udp: number
  procs: number
}

/** 节点，/api/nodes 与 /api/ws 帧内的元素 */
export interface MonitorNode {
  id: number
  name: string
  sort: number
  group: string | null
  public: boolean
  online: boolean
  /** ISO 3166-1 alpha-2 国家代码，如 US、HK */
  country: string
  /** 最后上报时间（秒） */
  last_seen: number
  /** 距最后上报的秒数，按 hub 的时钟算；从未上报为 null。hub 1.4.0 起下发 */
  last_seen_ago?: number | null
  os: string
  kernel: string
  arch: string
  virt: string
  cpu_name: string
  cpu_cores: number
  mem_total: number
  swap_total: number
  disk_total: number
  agent_version: string
  price: number
  currency: string
  /** yearly / quarterly / monthly / once 等文案 */
  billing_cycle: string
  expires_at: string | null
  /** 距到期天数，Hub 已按日历日计算；null 表示未设置到期时间 */
  expires_in: number | null
  traffic_limit: number
  /** sum / max / min / up / down */
  traffic_mode: string
  traffic_reset_day: number
  total_rx: number
  total_tx: number
  month_rx: number
  month_tx: number
  month_start: string
  day_rx: number
  day_tx: number
  /** 离线节点为 null */
  metrics: MonitorMetrics | null
  /** 以下字段仅登录后台后返回 */
  remark?: string
  public_remark?: string
  hostname?: string
  ip?: string
}

/** /api/nodes 与 /api/ws 的响应帧 */
export interface MonitorFrame {
  nodes: MonitorNode[]
  /** 当前访客是否为已登录管理员 */
  admin: boolean
}

/** 历史曲线上的一点 */
export interface MetricPoint {
  ts: number
  cpu: number
  mem_used: number
  disk_used: number
  net_rx: number
  net_tx: number
}

/** 历史延迟记录 */
export interface PingPoint {
  ts: number
  task_id: number
  /** null 表示该次探测超时 */
  latency: number | null
  /** 该桶内丢包率（%） */
  loss?: number
}

/** 历史窗口响应 */
export interface HistoryWindow {
  metrics: MetricPoint[]
  ping: PingPoint[]
  /** 探测线路：id -> 名称 */
  probes: Record<string, string>
  /** 窗口内丢包率（%）：id -> 数值 */
  loss: Record<string, number>
}

/** 站点与登录状态，GET /api/me */
export interface SiteInfo {
  authed: boolean
  github: boolean
  /** 是否为公开状态页 */
  public_page: boolean
  site: string
  site_name: string
  /** 历史保留天数，hub 1.3.2 起下发；旧 hub 没有这个字段 */
  history_days?: number
}
