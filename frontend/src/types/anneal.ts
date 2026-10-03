/**
 * 退火（Anneal）
 * 每件作品一条退火队列记录：排队时只登记目标退火窑与期望入窑时间（窑位留空）；
 * 窑务排产员按炉次编排后，记录挂到某个 KilnRun 上并分配该炉窑位，一炉多件并烧。
 * 作品壁厚改动后，已编排但尚未入窑的记录退回待入窑重排；已入窑的按原样烧完。
 */

/** 退火曲线段：升温 / 保温 / 缓冷 */
export type CurveSeg = '升温' | '保温' | '缓冷'

/** 退火状态：待入窑（排队中）/ 退火中 / 已出炉 */
export type AnnealState = '待入窑' | '退火中' | '已出炉'

export const CURVE_SEG_OPTIONS: CurveSeg[] = ['升温', '保温', '缓冷']
export const ANNEAL_STATE_OPTIONS: AnnealState[] = ['待入窑', '退火中', '已出炉']

/** 状态推进顺序 */
export const ANNEAL_STATE_FLOW: AnnealState[] = ['待入窑', '退火中', '已出炉']

export interface Anneal {
  id: string
  /** 所属作品 */
  pieceId: string
  /** 目标退火窑号（排队时就确定，如 AN-01）；炉次窑位由 kilnSlot 记录 */
  kilnCode: string
  /** 期望入窑时间 ISO（YYYY-MM-DDTHH:mm）：排产按它对齐并炉 */
  expectedInAt: string
  /**
   * 所属炉次 id；未排产（排队中）为空串。
   * 排产后写入，壁厚改动退回重排时清空。
   */
  runId: string
  /**
   * 炉次内分配到的具体窑位（退火窑号 + 格位，如 AN-01-A1）；
   * 未排产为空串。与同炉其他作品共用一组窑位，每件一格。
   */
  kilnSlot: string
  /** 曲线段（整炉一致，保留作记录展示） */
  curveSeg: CurveSeg
  /** 入窑时间 ISO（炉次实际入窑时回写） */
  inAt: string
  /** 出炉时间 ISO；未出炉为空串 */
  outAt: string
  /** 退火状态 */
  state: AnnealState
  createdAt: string
  updatedAt: string
  revision: number
}

/** 排队 / 编辑退火的表单草稿（只登记排队意向，窑位由排产分配） */
export interface AnnealDraft {
  pieceId: string
  kilnCode: string
  expectedInAt: string
  curveSeg: CurveSeg
}
