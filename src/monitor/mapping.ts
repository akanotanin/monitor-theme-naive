import type { MonitorNode } from './types'
import type { Client, NodeStatus } from '@/types/komari'
import { getEmojiByCode } from '@/utils/regionHelper'

/**
 * Monitor 的计费周期文案与 Komari 的天数表示互转
 * Komari 主题按天数（30/90/365…）判断周期类型，Hub 存的是文案
 */
const BILLING_CYCLE_DAYS: Record<string, number> = {
  'monthly': 30,
  'quarterly': 90,
  'semiannual': 180,
  'semi-annual': 180,
  'semi_annual': 180,
  'yearly': 365,
  'annual': 365,
  'biennial': 730,
  'triennial': 1095,
  'quinquennial': 1825,
  'once': -1,
}

/** Komari 的 traffic_limit_type 只认识这几种取值，其余一律按 sum 处理 */
const TRAFFIC_MODES = new Set(['sum', 'max', 'min', 'up', 'down'])

/** 计费周期文案转天数，未知文案返回 0（主题会显示为自定义周期） */
export function billingCycleDays(cycle: string | null | undefined): number {
  if (!cycle)
    return 0
  return BILLING_CYCLE_DAYS[cycle.trim().toLowerCase()] ?? 0
}

/** 国家代码转主题使用的旗帜 emoji；无法识别时返回空串，避免出现 404 的旗帜图片 */
function regionEmoji(country: string | null | undefined): string {
  const code = (country ?? '').trim().toUpperCase()
  if (!/^[A-Z]{2}$/.test(code))
    return ''
  const emoji = getEmojiByCode(code)
  return emoji === code ? '' : emoji
}

/** 浮点安全：Hub 未提供的字段保持 undefined，图表会画成空档而不是 0 */
function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * 把 Monitor 节点映射成 Komari 的 Client + NodeStatus
 * 主题的 store 与组件全部按 Komari 结构读取，因此映射后无需改动
 */
export function mapNode(node: MonitorNode): { client: Client, status: NodeStatus } {
  const m = node.online ? node.metrics : null
  const uuid = String(node.id)
  const upstream = node.total_tx ?? 0
  const downstream = node.total_rx ?? 0
  const monthUp = m?.month_tx ?? node.month_tx ?? 0
  const monthDown = m?.month_rx ?? node.month_rx ?? 0
  const load = Array.isArray(m?.load) ? m.load : []

  const client: Client = {
    uuid,
    name: node.name,
    cpu_name: node.cpu_name || '',
    virtualization: node.virt || '',
    arch: node.arch || '',
    cpu_cores: node.cpu_cores || 0,
    cpu_physical_cores: node.cpu_cores || 0,
    os: node.os || '',
    kernel_version: node.kernel || '',
    // 极简探针公开接口不提供 GPU 型号
    gpu_name: '',
    region: regionEmoji(node.country),
    remark: node.remark,
    public_remark: node.public_remark ?? '',
    mem_total: node.mem_total || 0,
    swap_total: node.swap_total || 0,
    disk_total: node.disk_total || 0,
    version: node.agent_version || '',
    weight: node.sort ?? 0,
    price: node.price ?? 0,
    billing_cycle: billingCycleDays(node.billing_cycle),
    auto_renewal: false,
    currency: node.currency || 'CNY',
    expired_at: node.expires_at || null,
    expires_in: node.expires_in ?? null,
    group: node.group ?? '',
    // 极简探针公开接口不提供标签
    tags: '',
    hidden: false,
    traffic_limit: node.traffic_limit ?? 0,
    traffic_limit_type: (TRAFFIC_MODES.has(node.traffic_mode) ? node.traffic_mode : 'sum') as Client['traffic_limit_type'],
    created_at: '',
    updated_at: '',
  }

  const status: NodeStatus = {
    client: uuid,
    time: node.last_seen ? new Date(node.last_seen * 1000).toISOString() : new Date().toISOString(),
    cpu: finite(m?.cpu) ?? 0,
    gpu: 0,
    ram: finite(m?.mem_used) ?? 0,
    ram_total: m?.mem_total ?? node.mem_total ?? 0,
    swap: finite(m?.swap_used) ?? 0,
    swap_total: m?.swap_total ?? node.swap_total ?? 0,
    load: finite(load[0]) ?? 0,
    load5: finite(load[1]) ?? 0,
    load15: finite(load[2]) ?? 0,
    // 极简探针不上报温度
    temp: 0,
    disk: finite(m?.disk_used) ?? 0,
    disk_total: m?.disk_total ?? node.disk_total ?? 0,
    net_in: finite(m?.net_rx) ?? 0,
    net_out: finite(m?.net_tx) ?? 0,
    // 主题的流量条与到期计算按「本计费周期」统计，与 Hub 的流量上限同一口径
    net_total_up: monthUp,
    net_total_down: monthDown,
    process: finite(m?.procs) ?? 0,
    connections: finite(m?.tcp) ?? 0,
    connections_udp: finite(m?.udp) ?? 0,
    online: Boolean(node.online),
    uptime: finite(m?.uptime) ?? 0,
  }

  // 生命周期累计流量单独保留，供需要总计的界面使用
  ;(status as NodeStatus & { traffic_up?: number, traffic_down?: number }).traffic_up = upstream
  ;(status as NodeStatus & { traffic_up?: number, traffic_down?: number }).traffic_down = downstream

  return { client, status }
}
