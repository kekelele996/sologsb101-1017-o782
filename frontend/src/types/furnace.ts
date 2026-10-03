/**
 * 窑炉（Furnace）
 * 熔化炉 / 坩埚炉 / 退火窑，退火窑自动进入窑位池，熔化炉可挂料液批次。
 */

/** 窑炉类型 */
export type FurnaceType = '熔化炉' | '坩埚炉' | '退火窑'

/** 燃料类型 */
export type FuelType = '电' | '燃气'

/** 窑炉状态：停窑 / 升温 / 运行 / 保温 */
export type FurnaceState = '停窑' | '升温' | '运行' | '保温'

export const FURNACE_TYPE_OPTIONS: FurnaceType[] = ['熔化炉', '坩埚炉', '退火窑']
export const FUEL_TYPE_OPTIONS: FuelType[] = ['电', '燃气']
export const FURNACE_STATE_OPTIONS: FurnaceState[] = ['停窑', '升温', '运行', '保温']

/** 退火窑默认装载容量（件/炉）；v2 以前的旧数据升级时按此补默认值 */
export const DEFAULT_ANNEAL_CAPACITY = 6

/** 退火窑装载容量允许的范围 */
export const MIN_ANNEAL_CAPACITY = 1
export const MAX_ANNEAL_CAPACITY = 60

export interface Furnace {
  id: string
  /** 窑号 */
  code: string
  /** 窑炉类型 */
  type: FurnaceType
  /** 最高温度（℃） */
  maxTempC: number
  /** 燃料类型 */
  fuelType: FuelType
  /** 运行状态 */
  state: FurnaceState
  /**
   * 装载容量（件/炉），按件数封顶；仅退火窑使用。
   * v2 以前的旧数据没有该字段，升级到 v3 时回填 DEFAULT_ANNEAL_CAPACITY。
   */
  loadCapacity: number
  createdAt: string
  updatedAt: string
  revision: number
}

/** 新建 / 编辑窑炉的表单草稿 */
export interface FurnaceDraft {
  code: string
  type: FurnaceType
  maxTempC: number
  fuelType: FuelType
  state: FurnaceState
  loadCapacity: number
}
