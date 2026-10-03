/**
 * 退火炉次（KilnRun）
 * 一炉并烧多件：曲线相同（由壁厚决定）、入窑时间对得上的待入窑作品并成一炉，共用一组窑位。
 * 计划侧（排产员）与实际侧（退火值守）各留一份字段；烧完件数对不上时在炉次说明里写清。
 */

/** 炉次状态：待入窑 / 退火中 / 已出炉 */
export type RunState = '待入窑' | '退火中' | '已出炉'

export const RUN_STATE_OPTIONS: RunState[] = ['待入窑', '退火中', '已出炉']

/** 状态推进顺序 */
export const RUN_STATE_FLOW: RunState[] = ['待入窑', '退火中', '已出炉']

export interface KilnRun {
  id: string
  /** 炉次序号（同一台退火窑内从 1 起递增） */
  seq: number
  /** 退火窑 id */
  furnaceId: string
  /** 退火窑号，如 AN-01 */
  kilnCode: string
  /** 曲线指纹：壁厚 mm 数字串；相同才允许并炉 */
  curveKey: string
  /** 该炉壁厚（mm），决定整炉升温 / 保温 / 缓冷曲线 */
  wallThicknessMm: number
  /** 本炉共用的一组窑位（每件一格），如 ['AN-01-A1','AN-01-A2'] */
  slots: string[]
  /** 计划入炉件（排队并炉时写入，排产侧留存） */
  planPieceIds: string[]
  /** 计划入窑时间 ISO（YYYY-MM-DDTHH:mm） */
  plannedInAt: string
  /** 计划出炉时间 ISO（入窑 + 该壁厚理论曲线时长） */
  plannedOutAt: string
  /** 炉次状态 */
  state: RunState
  /** 实际入窑时间 ISO；未入窑为空串（值守侧留存） */
  actualInAt: string
  /** 实际出炉时间 ISO；未出炉为空串（值守侧留存） */
  actualOutAt: string
  /** 实际随炉烧的件（入窑 / 出炉两次确认，允许与计划件数不一致） */
  actualPieceIds: string[]
  /** 值守说明：实际件数与计划对不上时必须在炉次上说清原因 */
  dutyNote: string
  createdAt: string
  updatedAt: string
  revision: number
}

/** 炉次展示码，如 AN-01 · 第 3 炉 */
export function runLabel(run: Pick<KilnRun, 'kilnCode' | 'seq'>): string {
  return `${run.kilnCode} · 第 ${run.seq} 炉`
}
