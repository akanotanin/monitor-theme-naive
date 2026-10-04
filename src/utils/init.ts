/**
 * 应用初始化模块
 * 负责启动流程、实时连接与轮询兜底
 * 数据来自极简探针的 /api/nodes 与 /api/ws，映射后写入 nodes store
 */

import type { LiveHandle } from '@/monitor/transport'
import type { MonitorNode } from '@/monitor/types'
import { connectLive, mappedNodes, readNodes } from '@/monitor/transport'
import { useAppStore } from '@/stores/app'
import { useNodesStore } from '@/stores/nodes'
import { getSharedApi } from '@/utils/api'

/** 初始化配置 */
interface InitConfig {
  /** 重连间隔（毫秒） */
  wsReconnectInterval?: number
  /** 最大重连次数，超过后只保留轮询 */
  wsMaxReconnectAttempts?: number
}

const DEFAULT_CONFIG: Required<InitConfig> = {
  wsReconnectInterval: 3000,
  wsMaxReconnectAttempts: 5,
}

/** 初始化状态管理 */
class InitManager {
  private config: Required<InitConfig>
  private appStore: ReturnType<typeof useAppStore>
  private nodesStore: ReturnType<typeof useNodesStore>
  private live: LiveHandle | null = null
  private pollTimer: ReturnType<typeof setInterval> | null = null
  private isPolling = false
  private isInitialized = false

  constructor(config: InitConfig = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config }
    this.appStore = useAppStore()
    this.nodesStore = useNodesStore()
  }

  /** 轮询间隔（毫秒），来自主题配置 dataUpdateInterval */
  private getPollInterval(): number {
    const interval = this.appStore.publicSettings?.theme_settings?.dataUpdateInterval
    if (typeof interval === 'number' && interval >= 1 && interval <= 60)
      return interval * 1000
    return 3000
  }

  /** 执行初始化流程 */
  async init(): Promise<void> {
    if (this.isInitialized) {
      console.warn('[InitManager] Already initialized')
      return
    }

    try {
      await this.fetchPublicSettings()
      await this.fetchUserInfo()
      await this.fetchNodesData()

      this.appStore.loading = false
      this.startLive()
      this.isInitialized = true
    }
    catch (error) {
      console.error('[InitManager] Initialization failed:', error)
      // 即使失败也解除加载状态，让页面显示错误提示
      this.appStore.loading = false
      throw error
    }
  }

  /** 站点公开属性与主题配置 */
  private async fetchPublicSettings(): Promise<void> {
    try {
      const settings = await getSharedApi().getPublicSettings()
      this.appStore.publicSettings = settings
      if (settings.sitename)
        document.title = settings.sitename
    }
    catch (error) {
      console.error('[InitManager] Failed to fetch public settings:', error)
      this.appStore.connectionError = true
    }
  }

  /** 登录状态 */
  private async fetchUserInfo(): Promise<void> {
    try {
      this.appStore.setUserInfo(await getSharedApi().getMe())
    }
    catch (error) {
      console.error('[InitManager] Failed to fetch user info:', error)
    }
  }

  /** 首屏节点数据 */
  private async fetchNodesData(): Promise<void> {
    const nodes = await readNodes()
    const { clients, statuses } = mappedNodes(nodes)
    this.nodesStore.initNodes(clients, statuses)
  }

  /** 把一帧节点数据写入 store */
  private applyNodes(nodes: MonitorNode[]): void {
    const { clients, statuses } = mappedNodes(nodes)
    this.nodesStore.updateNodeClients(clients)
    this.nodesStore.updateNodeStatuses(statuses)
    this.appStore.connectionError = false
  }

  /** 启动实时连接与轮询 */
  private startLive(): void {
    if (this.appStore.rpcTransportMode === 'websocket') {
      this.live = connectLive(
        nodes => this.applyNodes(nodes),
        (state) => {
          switch (state) {
            case 'connected':
              this.nodesStore.updateWsState('connected', 0)
              this.appStore.connectionError = false
              break
            case 'connecting':
              this.nodesStore.updateWsState('connecting', this.nodesStore.wsReconnectAttempts)
              break
            case 'reconnecting':
              if (this.nodesStore.wsReconnectAttempts === 0)
                window.$message?.error('实时连接中断，正在尝试重连。')
              this.nodesStore.updateWsState('reconnecting', this.nodesStore.wsReconnectAttempts + 1)
              break
            default:
              this.nodesStore.updateWsState('disconnected', this.config.wsMaxReconnectAttempts)
              window.$message?.warning('实时连接不可用，已回落轮询模式。')
              break
          }
        },
        { retryInterval: this.config.wsReconnectInterval, maxRetries: this.config.wsMaxReconnectAttempts },
      )
    }
    else {
      this.nodesStore.updateWsState('disconnected', this.config.wsMaxReconnectAttempts)
    }

    // 轮询作为实时连接的兜底，间隔由主题配置决定
    this.startPolling()
  }

  /** 开始轮询 */
  private startPolling(): void {
    if (this.pollTimer)
      clearInterval(this.pollTimer)
    this.pollTimer = setInterval(() => {
      void this.poll()
    }, this.getPollInterval())
  }

  /** 执行一次轮询 */
  private async poll(): Promise<void> {
    if (this.isPolling)
      return
    this.isPolling = true
    try {
      const nodes = await readNodes()
      this.applyNodes(nodes)
    }
    catch (error) {
      console.error('[InitManager] Poll error:', error)
      this.appStore.connectionError = true
    }
    finally {
      this.isPolling = false
    }
  }

  /** 停止轮询 */
  stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }
  }

  /** 登录状态或连接模式变化后重新连接 */
  async reconnectAfterLogin(): Promise<void> {
    this.live?.close()
    this.live = null
    await this.fetchUserInfo()
    await this.fetchNodesData()
    this.startLive()
  }

  /** 销毁管理器 */
  destroy(): void {
    this.stopPolling()
    this.live?.close()
    this.live = null
    this.nodesStore.clearNodes()
    this.isInitialized = false
  }
}

// 单例实例
let initManager: InitManager | null = null

/** 初始化应用 */
export async function initApp(): Promise<void> {
  if (!initManager)
    initManager = new InitManager()
  await initManager.init()
}

/** 获取初始化管理器实例 */
export function getInitManager(): InitManager | null {
  return initManager
}

/** 销毁初始化管理器 */
export function destroyInitManager(): void {
  if (initManager) {
    initManager.destroy()
    initManager = null
  }
}

/** 登录状态变化后重新连接 */
export async function reconnectAfterLogin(): Promise<void> {
  if (initManager)
    await initManager.reconnectAfterLogin()
}
