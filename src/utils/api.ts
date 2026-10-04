import type { MeInfo, PublicInfo, VersionInfo } from '@/types/komari'
import { loadConfig } from '@/monitor/config'
import { isAdmin, preserveHours, site } from '@/monitor/transport'

/**
 * 极简探针公开接口封装
 * 主题只关心「站点叫什么、我是不是管理员、数据保留多久、主题配置是什么」，
 * 这些都由 Monitor 的 /api/me 与主题配置接口提供。
 */

/** API 错误 */
export class ApiError extends Error {
  status: number

  constructor(message: string, status = 0) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

export class MonitorApi {
  /** 当前访客的登录状态与站点名称 */
  async getMe(): Promise<MeInfo> {
    const info = await site()
    if (!info.public_page && !info.authed) {
      // 站点未开放状态页：交给后台登录，登录后回到首页
      location.assign('/admin/')
    }
    return {
      logged_in: info.authed,
      username: info.authed ? '管理员' : '',
    }
  }

  /** 站点公开属性 + 主题配置 */
  async getPublicSettings(): Promise<PublicInfo> {
    const [info, config] = await Promise.all([site(), loadConfig()])
    const hours = preserveHours()
    return {
      cors_origin_check_enabled: false,
      custom_body: '',
      custom_head: '',
      description: '',
      disable_password_login: false,
      oauth_enable: Boolean(info.github),
      oauth_provider: info.github ? 'github' : null,
      ping_record_preserve_time: hours,
      private_site: !info.public_page,
      record_enabled: true,
      record_preserve_time: hours,
      sitename: info.site_name || 'Monitor',
      theme: 'naive',
      theme_settings: config,
    }
  }

  /** 后端版本：极简探针的版本接口仅对管理员开放，这里给出可读的标识 */
  async getVersion(): Promise<VersionInfo> {
    return { version: 'Monitor', hash: '' }
  }
}

// ==================== 单例 ====================

let sharedApiInstance: MonitorApi | null = null

/** 获取共享实例 */
export function getSharedApi(): MonitorApi {
  if (!sharedApiInstance)
    sharedApiInstance = new MonitorApi()
  return sharedApiInstance
}

/** 重置共享实例 */
export function resetSharedApi(): void {
  sharedApiInstance = null
}

/** 当前访客是否为已登录管理员 */
export { isAdmin }

export default MonitorApi
