/**
 * 退火（Anneal）
 * 每件待入窑作品先排队登记；曲线相同、时间能对上的由炉次（KilnBatch）并成一炉，
 * 每件在炉次共用的窑位组里各占一格；出炉即回写作品状态。
 */

/** 退火曲线段：升温 / 保温 / 缓冷 */
export type CurveSeg = '升温' | '保温' | '缓冷'

/** 退火状态：待入窑 / 退火中 / 已出炉 */
export type AnnealState = '待入窑' | '退火中' | '已出炉'

export const CURVE_SEG_OPTIONS: CurveSeg[] = ['升温', '保温', '缓冷']
export const ANNEAL_STATE_OPTIONS: AnnealState[] = ['待入窑', '退火中', '已出炉']

/** 状态推进顺序 */
export const ANNEAL_STATE_FLOW: AnnealState[] = ['待入窑', '退火中', '已出炉']

export interface Anneal {
  id: string
  /** 所属作品 */
  pieceId: string
  /**
   * 所属退火炉次 id；未排炉（仍在待入窑排队）时为空串。
   * 入炉后由炉次统一管窑位 / 时间 / 状态，单件不再单独编排。
   */
  batchId: string
  /**
   * 退火窑号 + 窑位，如 AN-01-A1；未排炉时为空串。
   * 同炉各件共用炉次的一组窑位，每件落在其中一格。
   */
  kilnSlot: string
  /** 曲线段；并炉时必须与炉次曲线一致 */
  curveSeg: CurveSeg
  /**
   * 入窑时间 ISO 字符串（YYYY-MM-DDTHH:mm）。
   * 待入窑排队时为「期望 / 最早可入窑时间」，用于判断能否赶上某一炉；
   * 正式入炉后由炉次实际入窑时间统一覆盖。
   */
  inAt: string
  /** 出炉时间 ISO 字符串；未出炉为空串 */
  outAt: string
  /** 退火状态 */
  state: AnnealState
  createdAt: string
  updatedAt: string
  revision: number
}

/** 排队登记 / 修改待入窑作品的表单草稿（窑位与时间由炉次编排时统一分配） */
export interface AnnealDraft {
  pieceId: string
  curveSeg: CurveSeg
  /** 期望 / 最早可入窑时间，用于判断能否赶上某一炉 */
  inAt: string
}
