/**
 * IndexedDB 持久化层（Dexie 封装）
 * - 数据库名：gbglassblow
 * - 含数据结构版本号与升级迁移逻辑：
 *   v1 → v2 为 Piece 增加 craft 索引并回填默认值；
 *   v2 → v3 新增退火炉次（kilnruns）表、退火窑装载容量 capacity，并把旧退火记录迁移为单件炉次。
 * - 提供各表增删改查、炉次排产 / 入炉 / 出炉、作品状态联动、整库快照导入导出与重置
 * 纯前端应用：不依赖任何后端服务或外部接口。
 */
import Dexie, { type Table } from 'dexie'
import type { Furnace } from '../types/furnace'
import type { GlassBatch } from '../types/batch'
import type { Piece, PieceState } from '../types/piece'
import type { Step } from '../types/step'
import type { Anneal } from '../types/anneal'
import type { KilnRun } from '../types/run'
import type { Inspect } from '../types/inspect'
import { nowIso, nowLocalInput, uuid } from './id'
import { seedDatabase } from './seed'
import { curveKeyOf, kilnSlots, parseAt, plannedOutAt } from './thermal'
import { planRunGroups, usedSlotsInWindow } from './run'

/** 数据库名 */
export const DB_NAME = 'gbglassblow'

/** 当前数据结构版本号（每次调整字段结构必须 +1 并补迁移） */
export const DB_SCHEMA_VERSION = 3

/** 数据行结构修订号 */
export const ROW_REVISION = 3

class GlassBlowDatabase extends Dexie {
  furnaces!: Table<Furnace, string>
  batches!: Table<GlassBatch, string>
  pieces!: Table<Piece, string>
  steps!: Table<Step, string>
  anneals!: Table<Anneal, string>
  kilnruns!: Table<KilnRun, string>
  inspects!: Table<Inspect, string>

  constructor() {
    super(DB_NAME)

    // ---------- v1：初版结构 ----------
    this.version(1).stores({
      furnaces: 'id, code, type, state, fuelType, createdAt',
      batches: 'id, furnaceId, colorCode, meltDate',
      pieces: 'id, batchId, state, artist',
      steps: 'id, pieceId, [pieceId+seq], seq',
      anneals: 'id, pieceId, kilnSlot, state, inAt',
      inspects: 'id, pieceId, date, result',
    })

    // ---------- v2：Piece 增加 craft 索引并回填默认值，补齐其余索引与字段 ----------
    this.version(2).stores({
      furnaces: 'id, code, type, state, fuelType, createdAt, updatedAt',
      batches: 'id, furnaceId, colorCode, meltDate, remainKg',
      // craft 为 v2 新增索引
      pieces: 'id, batchId, state, artist, craft, name',
      steps: 'id, pieceId, [pieceId+seq], seq, state, name',
      anneals: 'id, pieceId, kilnSlot, state, inAt, curveSeg',
      inspects: 'id, pieceId, date, result, inspector',
    })

    // ---------- v3：退火炉次化 + 退火窑装载容量 ----------
    this.version(DB_SCHEMA_VERSION)
      .stores({
        furnaces: 'id, code, type, state, fuelType, createdAt, updatedAt',
        batches: 'id, furnaceId, colorCode, meltDate, remainKg',
        pieces: 'id, batchId, state, artist, craft, name',
        steps: 'id, pieceId, [pieceId+seq], seq, state, name',
        // runId 为 v3 新增索引：排队记录 runId 为空，已排产的挂到具体炉次
        anneals: 'id, pieceId, kilnSlot, state, inAt, curveSeg, runId',
        // 新表：退火炉次
        kilnruns: 'id, furnaceId, kilnCode, state, curveKey, plannedInAt',
        inspects: 'id, pieceId, date, result, inspector',
      })
      .upgrade(async (tx) => {
        // 迁移 1：补齐 revision / createdAt / updatedAt（v3 新表 kilnruns 在下方单独处理）
        const tables = [
          tx.table('furnaces'),
          tx.table('batches'),
          tx.table('pieces'),
          tx.table('steps'),
          tx.table('anneals'),
          tx.table('inspects'),
        ]
        for (const table of tables) {
          await table.toCollection().modify((row: Record<string, unknown>) => {
            row.revision = ROW_REVISION
            if (typeof row.updatedAt !== 'string') row.updatedAt = typeof row.createdAt === 'string' ? row.createdAt : nowIso()
            if (typeof row.createdAt !== 'string') row.createdAt = nowIso()
          })
        }
        // 迁移 2：退火窑补默认装载容量（旧数据没有容量字段）
        await tx.table('furnaces').toCollection().modify((row: Record<string, unknown>) => {
          if (typeof row.capacity !== 'number' || row.capacity <= 0) {
            row.capacity = DEFAULT_KILN_CAPACITY_MIGRATION
          }
        })
        // 迁移 3：旧退火记录补 kilnCode / expectedInAt / runId 字段
        await tx.table('anneals').toCollection().modify((row: Record<string, unknown>) => {
          const slot = typeof row.kilnSlot === 'string' ? row.kilnSlot : ''
          if (typeof row.kilnCode !== 'string' || row.kilnCode === '') {
            row.kilnCode = slot.split('-').slice(0, -1).join('-') || 'AN-01'
          }
          if (typeof row.expectedInAt !== 'string' || row.expectedInAt === '') {
            row.expectedInAt = typeof row.inAt === 'string' && row.inAt !== '' ? row.inAt : nowLocalInput()
          }
          if (typeof row.runId !== 'string') row.runId = ''
        })
        // 迁移 4：把旧退火记录逐条迁成单件炉次（保留原窑位与入出炉时间）
        const [oldAnneals, oldFurnaces, oldPieces] = await Promise.all([
          tx.table('anneals').toCollection().toArray() as Promise<Record<string, unknown>[]>,
          tx.table('furnaces').toCollection().toArray() as Promise<Record<string, unknown>[]>,
          tx.table('pieces').toCollection().toArray() as Promise<Record<string, unknown>[]>,
        ])
        const stamp = nowIso()
        const seqByKiln = new Map<string, number>()
        const runByAnneal = new Map<string, KilnRun>()
        const legacyRuns: KilnRun[] = []
        for (const row of oldAnneals) {
          if (row.runId !== '') continue
          const kilnCode = String(row.kilnCode)
          const furnace = oldFurnaces.find((item) => item.code === kilnCode && item.type === '退火窑')
          const piece = oldPieces.find((item) => item.id === row.pieceId)
          const thickness = typeof piece?.wallThicknessMm === 'number' ? piece.wallThicknessMm : 4
          const inAt = typeof row.inAt === 'string' && row.inAt !== '' ? row.inAt : String(row.expectedInAt)
          const outAt = typeof row.outAt === 'string' ? row.outAt : ''
          const state = String(row.state) as KilnRun['state']
          const seq = (seqByKiln.get(kilnCode) ?? 0) + 1
          seqByKiln.set(kilnCode, seq)
          const run: KilnRun = {
            id: uuid('run'),
            seq,
            furnaceId: furnace ? String(furnace.id) : '',
            kilnCode,
            curveKey: curveKeyOf(thickness),
            wallThicknessMm: thickness,
            slots: typeof row.kilnSlot === 'string' && row.kilnSlot !== '' ? [String(row.kilnSlot)] : [],
            planPieceIds: [String(row.pieceId)],
            plannedInAt: String(row.expectedInAt),
            plannedOutAt: outAt !== '' ? outAt : plannedOutAt(inAt, thickness),
            state,
            actualInAt: state === '待入窑' ? '' : inAt,
            actualOutAt: state === '已出炉' ? outAt : '',
            actualPieceIds: state === '待入窑' ? [] : [String(row.pieceId)],
            dutyNote: '',
            createdAt: typeof row.createdAt === 'string' ? row.createdAt : stamp,
            updatedAt: stamp,
            revision: ROW_REVISION,
          }
          legacyRuns.push(run)
          runByAnneal.set(String(row.id), run)
        }
        if (legacyRuns.length > 0) {
          await tx.table('kilnruns').bulkPut(legacyRuns)
          await tx.table('anneals').toCollection().modify((row: Record<string, unknown>) => {
            const run = runByAnneal.get(String(row.id))
            if (run !== undefined) row.runId = run.id
          })
        }
      })
  }
}

/** 迁移用默认容量（避免与 thermal 形成循环引用，值与 DEFAULT_KILN_CAPACITY 保持一致） */
const DEFAULT_KILN_CAPACITY_MIGRATION = 9

export const db = new GlassBlowDatabase()

/* ------------------------------ 初始化与播种 ------------------------------ */

let initPromise: Promise<void> | null = null

/**
 * 打开数据库并在首屏自动播种演示数据（幂等：仅当主表为空时播种）。
 * 多次调用共用同一个 Promise，避免并发重复播种。
 */
export function initDatabase(): Promise<void> {
  if (initPromise === null) {
    initPromise = (async (): Promise<void> => {
      await db.open()
      // 首屏自动播种演示数据：仅当主表为空时执行（幂等）
      if ((await db.furnaces.count()) === 0) {
        await seedDatabase()
      }
    })()
  }
  return initPromise
}

/* -------------------------------- 窑炉 -------------------------------- */

export async function listFurnaces(): Promise<Furnace[]> {
  const rows = await db.furnaces.toArray()
  return rows.sort((a, b) => a.code.localeCompare(b.code, 'zh-Hans-CN'))
}

export async function putFurnace(row: Furnace): Promise<void> {
  await db.furnaces.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION })
}

/** 删除窑炉：级联清理该窑下的料液批次；删除退火窑时解散其炉次并让退火记录回到队列 */
export async function removeFurnace(id: string): Promise<void> {
  await db.transaction('rw', db.furnaces, db.batches, db.kilnruns, db.anneals, async () => {
    const furnace = await db.furnaces.get(id)
    if (furnace?.type === '退火窑') {
      const runIds = new Set((await db.kilnruns.where('furnaceId').equals(id).toArray()).map((row) => row.id))
      if (runIds.size > 0) {
        await db.anneals.toCollection().modify((row: Anneal) => {
          if (runIds.has(row.runId)) {
            row.runId = ''
            row.kilnSlot = ''
            row.inAt = ''
            row.outAt = ''
            row.state = '待入窑'
          }
        })
      }
      await db.kilnruns.where('furnaceId').equals(id).delete()
    }
    await db.batches.where('furnaceId').equals(id).delete()
    await db.furnaces.delete(id)
  })
}

/* ------------------------------ 料液批次 ------------------------------ */

export async function listBatches(): Promise<GlassBatch[]> {
  const rows = await db.batches.toArray()
  return rows.sort((a, b) => b.meltDate.localeCompare(a.meltDate))
}

export async function putBatch(row: GlassBatch): Promise<void> {
  await db.batches.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION })
}

export async function removeBatch(id: string): Promise<void> {
  await db.batches.delete(id)
}

/** 取料：按剩余量扣减（不足时扣到 0 并返回实际扣减量） */
export async function consumeBatch(batchId: string, kg: number): Promise<number> {
  const batch = await db.batches.get(batchId)
  if (!batch) return 0
  const actual = Math.max(0, Math.min(batch.remainKg, kg))
  await db.batches.update(batchId, { remainKg: Math.round((batch.remainKg - actual) * 10) / 10, updatedAt: nowIso() })
  return actual
}

/* -------------------------------- 作品 -------------------------------- */

export async function listPieces(): Promise<Piece[]> {
  const rows = await db.pieces.toArray()
  return rows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

export async function putPiece(row: Piece): Promise<void> {
  await db.pieces.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION })
}

/**
 * 作品壁厚改动后的炉次处理：
 * - 待入窑炉次里的该件：退出炉次（解散占位），退回待入窑队列，随新壁厚重新编排；
 *   若该炉因此空了则删除炉次；
 * - 已入窑（退火中 / 已出炉）炉次里的该件：按原样烧完，不动炉次与曲线。
 * 返回被退回重排的退火记录数。
 */
export async function requeueAnnealsByPiece(pieceId: string): Promise<number> {
  let count = 0
  await db.transaction('rw', db.pieces, db.anneals, db.kilnruns, async () => {
    const anneals = await db.anneals.where('pieceId').equals(pieceId).toArray()
    for (const anneal of anneals) {
      if (anneal.runId === '') continue
      const run = await db.kilnruns.get(anneal.runId)
      if (!run || run.state !== '待入窑') continue
      count += 1
      await db.anneals.update(anneal.id, { runId: '', kilnSlot: '', inAt: '', outAt: '', state: '待入窑', updatedAt: nowIso() })
      const planPieceIds = run.planPieceIds.filter((id) => id !== pieceId)
      const slotOf = anneal.kilnSlot
      const slots = run.slots.filter((slot) => slot !== slotOf)
      if (planPieceIds.length === 0) {
        await db.kilnruns.delete(run.id)
      } else {
        await db.kilnruns.update(run.id, { planPieceIds, slots, updatedAt: nowIso() })
      }
    }
  })
  return count
}

/** 删除作品：级联清理工序、退火与检验记录；待入窑炉次同步移除该件，在烧 / 已出炉炉次留痕 */
export async function removePiece(id: string): Promise<void> {
  await db.transaction('rw', db.pieces, db.steps, db.anneals, db.kilnruns, db.inspects, async () => {
    const anneals = await db.anneals.where('pieceId').equals(id).toArray()
    for (const anneal of anneals) {
      if (anneal.runId === '') continue
      const run = await db.kilnruns.get(anneal.runId)
      if (!run || run.state !== '待入窑') continue
      const planPieceIds = run.planPieceIds.filter((pieceId) => pieceId !== id)
      const slots = run.slots.filter((slot) => slot !== anneal.kilnSlot)
      if (planPieceIds.length === 0) {
        await db.kilnruns.delete(run.id)
      } else {
        await db.kilnruns.update(run.id, { planPieceIds, slots, updatedAt: nowIso() })
      }
    }
    await db.steps.where('pieceId').equals(id).delete()
    await db.anneals.where('pieceId').equals(id).delete()
    await db.inspects.where('pieceId').equals(id).delete()
    await db.pieces.delete(id)
  })
}

/**
 * 依工序与退火、检验记录推导并回写作品状态。
 * 规则：有检验记录 → 已检验；有已出炉退火 → 已退火；有工序记录 → 制作中；否则设计中。
 */
export async function syncPieceState(pieceId: string): Promise<PieceState | null> {
  const piece = await db.pieces.get(pieceId)
  if (!piece) return null
  const [steps, anneals, inspects] = await Promise.all([
    db.steps.where('pieceId').equals(pieceId).toArray(),
    db.anneals.where('pieceId').equals(pieceId).toArray(),
    db.inspects.where('pieceId').equals(pieceId).toArray(),
  ])

  let next: PieceState = '设计中'
  if (steps.length > 0) next = '制作中'
  if (anneals.some((row) => row.state === '已出炉')) next = '已退火'
  if (inspects.length > 0) next = '已检验'

  if (next !== piece.state) {
    await db.pieces.update(pieceId, { state: next, updatedAt: nowIso() })
  }
  return next
}

/**
 * 事务内推导作品状态（不另开事务，供 rw 事务调用，避免 IndexedDB 跨事务读未锁表报错）。
 * 规则与 syncPieceState 一致：有检验 → 已检验；有已出炉退火 → 已退火；有工序 → 制作中；否则设计中。
 */
async function derivePieceStateInTx(pieceId: string): Promise<PieceState | null> {
  const piece = await db.pieces.get(pieceId)
  if (!piece) return null
  const [stepCount, doneAnneals, inspectCount] = await Promise.all([
    db.steps.where('pieceId').equals(pieceId).count(),
    db.anneals.where('pieceId').equals(pieceId).filter((row) => row.state === '已出炉').count(),
    db.inspects.where('pieceId').equals(pieceId).count(),
  ])
  let next: PieceState = '设计中'
  if (stepCount > 0) next = '制作中'
  if (doneAnneals > 0) next = '已退火'
  if (inspectCount > 0) next = '已检验'
  if (next !== piece.state) {
    await db.pieces.update(pieceId, { state: next, updatedAt: nowIso() })
  }
  return next
}

/* -------------------------------- 工序 -------------------------------- */

export async function listSteps(): Promise<Step[]> {
  const rows = await db.steps.toArray()
  return rows.sort((a, b) => a.pieceId.localeCompare(b.pieceId) || a.seq - b.seq)
}

export async function listStepsByPiece(pieceId: string): Promise<Step[]> {
  const rows = await db.steps.where('pieceId').equals(pieceId).toArray()
  return rows.sort((a, b) => a.seq - b.seq)
}

export async function putStep(row: Step): Promise<void> {
  await db.steps.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION })
  await syncPieceState(row.pieceId)
}

export async function removeStep(id: string): Promise<void> {
  const step = await db.steps.get(id)
  if (!step) return
  await db.steps.delete(id)
  await syncPieceState(step.pieceId)
}

/** 按给定 id 顺序重写工序序号（拖拽排序后调用） */
export async function reorderSteps(orderedIds: string[]): Promise<void> {
  await db.transaction('rw', db.steps, async () => {
    for (let index = 0; index < orderedIds.length; index += 1) {
      await db.steps.update(orderedIds[index], { seq: index + 1, updatedAt: nowIso() })
    }
  })
}

/* -------------------------------- 退火 -------------------------------- */

export async function listAnneals(): Promise<Anneal[]> {
  const rows = await db.anneals.toArray()
  return rows.sort((a, b) => a.expectedInAt.localeCompare(b.expectedInAt))
}

export async function listAnnealsByPiece(pieceId: string): Promise<Anneal[]> {
  return db.anneals.where('pieceId').equals(pieceId).toArray()
}

export async function putAnneal(row: Anneal): Promise<void> {
  await db.anneals.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION })
  await syncPieceState(row.pieceId)
}

export async function removeAnneal(id: string): Promise<void> {
  const row = await db.anneals.get(id)
  if (!row) return
  await db.transaction('rw', db.anneals, db.kilnruns, async () => {
    if (row.runId !== '') {
      const run = await db.kilnruns.get(row.runId)
      if (run && run.state === '待入窑') {
        const planPieceIds = run.planPieceIds.filter((pieceId) => pieceId !== row.pieceId)
        const slots = run.slots.filter((slot) => slot !== row.kilnSlot)
        if (planPieceIds.length === 0) {
          await db.kilnruns.delete(run.id)
        } else {
          await db.kilnruns.update(run.id, { planPieceIds, slots, updatedAt: nowIso() })
        }
      }
    }
    await db.anneals.delete(id)
  })
  await syncPieceState(row.pieceId)
}

/* -------------------------------- 炉次 -------------------------------- */

export async function listRuns(): Promise<KilnRun[]> {
  const rows = await db.kilnruns.toArray()
  return rows.sort((a, b) => a.plannedInAt.localeCompare(b.plannedInAt) || a.seq - b.seq)
}

/** 取该退火窑下一个炉次序号 */
async function nextRunSeq(txRuns: Table<KilnRun, string>, furnaceId: string, extra: KilnRun[]): Promise<number> {
  const existing = await txRuns.where('furnaceId').equals(furnaceId).toArray()
  const max = Math.max(0, ...existing.map((row) => row.seq), ...extra.filter((row) => row.furnaceId === furnaceId).map((row) => row.seq))
  return max + 1
}

export interface ScheduleOutcome {
  /** 本次新建的炉次 */
  created: KilnRun[]
  /** 排不进、继续等下一炉的退火记录 */
  blocked: Anneal[]
}

/**
 * 按炉次编排：把待入窑队列中曲线相同、时间对得上的作品并成一炉，
 * 按退火窑容量封顶；装不下或撞炉窗口的留在队列等下一炉，不挤已入窑的炉。
 */
export async function scheduleRunQueue(): Promise<ScheduleOutcome> {
  return db.transaction('rw', db.kilnruns, db.anneals, db.furnaces, db.pieces, async () => {
    const [furnaces, pieces, runs, anneals] = await Promise.all([
      db.furnaces.toArray(),
      db.pieces.toArray(),
      db.kilnruns.toArray(),
      db.anneals.toArray(),
    ])
    const queued = anneals.filter((row) => row.state === '待入窑' && row.runId === '')
    const { groups, blockedAnnealIds } = planRunGroups(queued, furnaces, pieces, runs)

    const created: KilnRun[] = []
    const stamp = nowIso()
    for (const group of groups) {
      const window: [number, number] = [parseAt(group.plannedInAt), parseAt(group.plannedOutAt)]
      // 只避开在时间窗重叠的其他炉次窑位（本组之外）
      const usedSlots = usedSlotsInWindow([...runs, ...created], window)
      const pool = kilnSlots(group.kilnCode).slice(0, group.capacity).filter((slot) => !usedSlots.has(slot))
      const slots = pool.slice(0, group.anneals.length)
      if (slots.length < group.anneals.length) {
        // 窑位实际不够（容量大于物理窑位数等异常情况）：整组留下次排
        group.anneals.forEach((row) => blockedAnnealIds.push(row.id))
        continue
      }
      const seq = await nextRunSeq(db.kilnruns, group.furnaceId, created)
      const run: KilnRun = {
        id: uuid('run'),
        seq,
        furnaceId: group.furnaceId,
        kilnCode: group.kilnCode,
        curveKey: group.curveKey,
        wallThicknessMm: group.wallThicknessMm,
        slots,
        planPieceIds: group.anneals.map((row) => row.pieceId),
        plannedInAt: group.plannedInAt,
        plannedOutAt: group.plannedOutAt,
        state: '待入窑',
        actualInAt: '',
        actualOutAt: '',
        actualPieceIds: [],
        dutyNote: '',
        createdAt: stamp,
        updatedAt: stamp,
        revision: ROW_REVISION,
      }
      await db.kilnruns.put(run)
      for (let index = 0; index < group.anneals.length; index += 1) {
        const anneal = group.anneals[index]
        await db.anneals.update(anneal.id, { runId: run.id, kilnSlot: slots[index], updatedAt: stamp })
      }
      created.push(run)
    }

    const blockedSet = new Set(blockedAnnealIds)
    return { created, blocked: anneals.filter((row) => blockedSet.has(row.id)) }
  })
}

export interface RunCheckResult {
  run: KilnRun
  /** 计划有、实际未随炉的件（退回待入窑重排） */
  missingPieceIds: string[]
}

/**
 * 退火值守：登记整炉实际入窑。
 * 勾选实际随炉的计划件；没到场的件退回待入窑队列重排，实际件数对不上时在炉次说明里写清。
 */
export async function checkinRun(
  runId: string,
  actualInAt: string,
  actualPieceIds: string[],
  dutyNote: string,
): Promise<RunCheckResult | null> {
  return db.transaction('rw', db.kilnruns, db.anneals, db.pieces, db.steps, db.inspects, async () => {
    const run = await db.kilnruns.get(runId)
    if (!run || run.state !== '待入窑') return null
    const presentSet = new Set(actualPieceIds.filter((id) => run.planPieceIds.includes(id)))
    const missingPieceIds = run.planPieceIds.filter((id) => !presentSet.has(id))
    const presentIds = run.planPieceIds.filter((id) => presentSet.has(id))
    const stamp = nowIso()

    const anneals = await db.anneals.where('runId').equals(runId).toArray()
    for (const anneal of anneals) {
      if (presentSet.has(anneal.pieceId)) {
        await db.anneals.update(anneal.id, { state: '退火中', inAt: actualInAt, updatedAt: stamp })
      } else {
        await db.anneals.update(anneal.id, {
          state: '待入窑',
          runId: '',
          kilnSlot: '',
          inAt: '',
          outAt: '',
          updatedAt: stamp,
        })
      }
    }

    let note = dutyNote.trim()
    if (missingPieceIds.length > 0 && note === '') {
      note = `计划 ${run.planPieceIds.length} 件，实际入窑 ${presentIds.length} 件，${missingPieceIds.length} 件未随炉，已退回待入窑重排。`
    }
    const slots = run.slots.filter((_, index) => presentIds.includes(run.planPieceIds[index]))
    const next: KilnRun = {
      ...run,
      state: '退火中',
      actualInAt,
      actualPieceIds: presentIds,
      slots: slots.length > 0 ? slots : run.slots,
      dutyNote: note,
      updatedAt: stamp,
      revision: ROW_REVISION,
    }
    await db.kilnruns.put(next)
    await Promise.all(run.planPieceIds.map((id) => derivePieceStateInTx(id)))
    return { run: next, missingPieceIds }
  })
}

/**
 * 退火值守：登记整炉出炉。
 * 出炉件数以本炉实际在烧件为准；与计划件数对不上时以炉次 dutyNote 说明为准。
 */
export async function closeRun(
  runId: string,
  actualOutAt: string,
  actualPieceIds: string[],
  dutyNote: string,
): Promise<KilnRun | null> {
  return db.transaction('rw', db.kilnruns, db.anneals, db.pieces, db.steps, db.inspects, async () => {
    const run = await db.kilnruns.get(runId)
    if (!run || run.state !== '退火中') return null
    const presentSet = new Set(actualPieceIds.filter((id) => run.actualPieceIds.includes(id)))
    const presentIds = run.actualPieceIds.filter((id) => presentSet.has(id))
    const missingCount = run.actualPieceIds.length - presentIds.length
    const stamp = nowIso()

    const anneals = await db.anneals.where('runId').equals(runId).toArray()
    for (const anneal of anneals) {
      if (presentSet.has(anneal.pieceId)) {
        await db.anneals.update(anneal.id, { state: '已出炉', outAt: actualOutAt, updatedAt: stamp })
      }
    }

    let note = dutyNote.trim()
    if (missingCount > 0 && note === '') {
      note = `入炉 ${run.actualPieceIds.length} 件，实际出炉 ${presentIds.length} 件，${missingCount} 件件数不符，请值守核对后补充说明。`
    }
    const next: KilnRun = {
      ...run,
      state: '已出炉',
      actualOutAt,
      actualPieceIds: presentIds,
      dutyNote: note,
      updatedAt: stamp,
      revision: ROW_REVISION,
    }
    await db.kilnruns.put(next)
    await Promise.all(presentIds.map((id) => derivePieceStateInTx(id)))
    return next
  })
}

/* ------------------------------ 出炉检验 ------------------------------ */

export async function listInspects(): Promise<Inspect[]> {
  const rows = await db.inspects.toArray()
  return rows.sort((a, b) => b.date.localeCompare(a.date))
}

export async function listInspectsByPiece(pieceId: string): Promise<Inspect[]> {
  const rows = await db.inspects.where('pieceId').equals(pieceId).toArray()
  return rows.sort((a, b) => b.date.localeCompare(a.date))
}

export async function putInspect(row: Inspect): Promise<void> {
  await db.inspects.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION })
  await syncPieceState(row.pieceId)
}

export async function removeInspect(id: string): Promise<void> {
  const row = await db.inspects.get(id)
  if (!row) return
  await db.inspects.delete(id)
  await syncPieceState(row.pieceId)
}

/* ---------------------------- 整库快照 ---------------------------- */

export interface DatabaseSnapshot {
  name: string
  schemaVersion: number
  exportedAt: string
  furnaces: Furnace[]
  batches: GlassBatch[]
  pieces: Piece[]
  steps: Step[]
  anneals: Anneal[]
  kilnruns: KilnRun[]
  inspects: Inspect[]
}

export async function exportSnapshot(): Promise<DatabaseSnapshot> {
  const [furnaces, batches, pieces, steps, anneals, kilnruns, inspects] = await Promise.all([
    db.furnaces.toArray(),
    db.batches.toArray(),
    db.pieces.toArray(),
    db.steps.toArray(),
    db.anneals.toArray(),
    db.kilnruns.toArray(),
    db.inspects.toArray(),
  ])
  return {
    name: DB_NAME,
    schemaVersion: DB_SCHEMA_VERSION,
    exportedAt: nowIso(),
    furnaces,
    batches,
    pieces,
    steps,
    anneals,
    kilnruns,
    inspects,
  }
}

export async function importSnapshot(snapshot: DatabaseSnapshot): Promise<void> {
  await db.transaction(
    'rw',
    [db.furnaces, db.batches, db.pieces, db.steps, db.anneals, db.kilnruns, db.inspects],
    async () => {
      await Promise.all([
        db.furnaces.clear(),
        db.batches.clear(),
        db.pieces.clear(),
        db.steps.clear(),
        db.anneals.clear(),
        db.kilnruns.clear(),
        db.inspects.clear(),
      ])
      // 兼容更早版本的存档：补容量 / 炉次字段
      await db.furnaces.bulkPut(
        snapshot.furnaces.map((row) => ({ ...row, capacity: row.capacity ?? 9, revision: ROW_REVISION })),
      )
      await db.batches.bulkPut(snapshot.batches.map((row) => ({ ...row, revision: ROW_REVISION })))
      await db.pieces.bulkPut(snapshot.pieces.map((row) => ({ ...row, revision: ROW_REVISION })))
      await db.steps.bulkPut(snapshot.steps.map((row) => ({ ...row, revision: ROW_REVISION })))
      await db.anneals.bulkPut(
        (snapshot.anneals ?? []).map((row) => ({
          ...row,
          kilnCode: row.kilnCode ?? row.kilnSlot?.split('-').slice(0, -1).join('-') ?? 'AN-01',
          expectedInAt: row.expectedInAt ?? row.inAt ?? '',
          runId: row.runId ?? '',
          revision: ROW_REVISION,
        })),
      )
      await db.kilnruns.bulkPut((snapshot.kilnruns ?? []).map((row) => ({ ...row, revision: ROW_REVISION })))
      await db.inspects.bulkPut(snapshot.inspects.map((row) => ({ ...row, revision: ROW_REVISION })))
    },
  )
}

export async function resetDatabase(): Promise<void> {
  await db.transaction(
    'rw',
    [db.furnaces, db.batches, db.pieces, db.steps, db.anneals, db.kilnruns, db.inspects],
    async () => {
      await Promise.all([
        db.furnaces.clear(),
        db.batches.clear(),
        db.pieces.clear(),
        db.steps.clear(),
        db.anneals.clear(),
        db.kilnruns.clear(),
        db.inspects.clear(),
      ])
    },
  )
  await seedDatabase()
}

export async function countAll(): Promise<Record<string, number>> {
  const [furnaces, batches, pieces, steps, anneals, kilnruns, inspects] = await Promise.all([
    db.furnaces.count(),
    db.batches.count(),
    db.pieces.count(),
    db.steps.count(),
    db.anneals.count(),
    db.kilnruns.count(),
    db.inspects.count(),
  ])
  return { furnaces, batches, pieces, steps, anneals, kilnruns, inspects }
}
