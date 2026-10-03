/**
 * 退火炉次（KilnBatch）
 * 一台退火窑一次烧成为一炉：曲线相同、时间能对上的待入窑作品并成一炉，共用一组窑位。
 * 装载容量按件数封顶，排不下的先排队等下一炉；退火值守按炉次记实际入窑 / 出炉。
 */
import type { AnnealState, CurveSeg } from './anneal'

/** 退火窑一炉的窑位编排方式：整炉共用一组窑位（如 A1–A3），每件作品落在其中一格 */
export type SlotLayout = string

/** 炉次状态与作品退火状态一致，按炉次整体推进 */
export type KilnBatchState = AnnealState

export const KILN_BATCH_STATE_OPTIONS: KilnBatchState[] = ['待入窑', '退火中', '已出炉']

/** 状态推进顺序 */
export const KILN_BATCH_STATE_FLOW: KilnBatchState[] = ['待入窑', '退火中', '已出炉']

export interface KilnBatch {
  id: string
  /** 退火窑号，如 AN-01（窑位前缀） */
  kilnCode: string
  /** 炉次号（同窑内按开炉顺序递增的序号，仅用于展示） */
  seq: number
  /** 整炉共用的退火曲线段：只有曲线相同的作品才能并炉 */
  curveSeg: CurveSeg
  /** 计划 / 实际入窑时间 ISO 字符串（YYYY-MM-DDTHH:mm） */
  inAt: string
  /** 实际出炉时间 ISO 字符串；未出炉为空串 */
  outAt: string
  /** 炉次状态（待入窑 / 退火中 / 已出炉） */
  state: KilnBatchState
  /** 建炉时的装载容量快照（件），封顶件数；来自退火窑 loadCapacity */
  capacity: number
  /**
   * 整炉共用的窑位（每件作品仍在 anneal.kilnSlot 上各占一格）。
   * 保存建炉时该窑分配到的窑位列表，如 ['AN-01-A1','AN-01-A2']。
   */
  slots: string[]
  /** 值守人（退火值班登记） */
  keeper: string
  /** 出炉件数：值守登记的实际出炉件数；为空表示尚未清点 */
  outCount: number | null
  /** 出炉件数对不上时的情况说明（烧完件数对不上要在炉次上说清） */
  mismatchNote: string
  createdAt: string
  updatedAt: string
  revision: number
}

/** 新建炉次的表单草稿 */
export interface KilnBatchDraft {
  kilnCode: string
  curveSeg: CurveSeg
  inAt: string
  capacity: number
  keeper: string
}
