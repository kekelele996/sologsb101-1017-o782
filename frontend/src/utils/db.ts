/**
 * IndexedDB 持久化层（Dexie 封装）
 * - 数据库名：gbglassblow
 * - 含数据结构版本号与升级迁移逻辑
 *   v1 → v2 为 Piece 增加 craft 索引并回填默认值；
 *   v2 → v3 新增退火炉次（kilnBatches）表，退火改为按炉次组炉 / 容量封顶，
 *         并为退火窑补装载容量默认值、把历史单件退火记录迁移归炉。
 * - 提供各表增删改查、作品状态联动、整库快照导入导出与重置
 * 纯前端应用：不依赖任何后端服务或外部接口。
 */
import Dexie, { type Table } from 'dexie'
import type { Furnace } from '../types/furnace'
import { DEFAULT_ANNEAL_CAPACITY } from '../types/furnace'
import type { GlassBatch } from '../types/batch'
import type { Piece, PieceState } from '../types/piece'
import type { Step } from '../types/step'
import type { Anneal, CurveSeg } from '../types/anneal'
import type { KilnBatch } from '../types/kilnBatch'
import type { Inspect } from '../types/inspect'
import { nowIso } from './id'
import { seedDatabase } from './seed'

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
  kilnBatches!: Table<KilnBatch, string>
  anneals!: Table<Anneal, string>
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
    this.version(2)
      .stores({
        furnaces: 'id, code, type, state, fuelType, createdAt, updatedAt',
        batches: 'id, furnaceId, colorCode, meltDate, remainKg',
        // craft 为 v2 新增索引
        pieces: 'id, batchId, state, artist, craft, name',
        steps: 'id, pieceId, [pieceId+seq], seq, state, name',
        anneals: 'id, pieceId, kilnSlot, state, inAt, curveSeg',
        inspects: 'id, pieceId, date, result, inspector',
      })
      .upgrade(async (tx) => {
        // 迁移 1：补齐 revision / createdAt / updatedAt
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
            if (typeof row.createdAt !== 'string') row.createdAt = nowIso()
            if (typeof row.updatedAt !== 'string') row.updatedAt = row.createdAt
          })
        }
        // 迁移 2：Piece 补齐 craft 字段（历史作品默认按吹制归类）
        await tx.table('pieces').toCollection().modify((row: Record<string, unknown>) => {
          if (typeof row.craft !== 'string' || row.craft === '') row.craft = '吹制'
          if (typeof row.state !== 'string' || row.state === '') row.state = '设计中'
        })
        // 迁移 3：历史工序默认视为已执行完成，避免升级后被误判为待办
        await tx.table('steps').toCollection().modify((row: Record<string, unknown>) => {
          if (typeof row.state !== 'string' || row.state === '') row.state = '已完成'
          if (typeof row.remark !== 'string') row.remark = ''
        })
        // 迁移 4：退火记录补齐出炉时间与曲线段
        await tx.table('anneals').toCollection().modify((row: Record<string, unknown>) => {
          if (typeof row.outAt !== 'string') row.outAt = ''
          if (typeof row.curveSeg !== 'string' || row.curveSeg === '') row.curveSeg = '缓冷'
        })
        // 迁移 5：检验记录补齐缺陷说明
        await tx.table('inspects').toCollection().modify((row: Record<string, unknown>) => {
          if (typeof row.defectNote !== 'string') row.defectNote = ''
        })
      })

    // ---------- v3：退火按炉次组炉，新增 kilnBatches 表与装载容量 ----------
    this.version(DB_SCHEMA_VERSION)
      .stores({
        furnaces: 'id, code, type, state, fuelType, createdAt, updatedAt',
        batches: 'id, furnaceId, colorCode, meltDate, remainKg',
        pieces: 'id, batchId, state, artist, craft, name',
        steps: 'id, pieceId, [pieceId+seq], seq, state, name',
        // batchId 为 v3 新增索引
        kilnBatches: 'id, kilnCode, state, curveSeg, inAt',
        anneals: 'id, pieceId, batchId, kilnSlot, state, inAt, curveSeg',
        inspects: 'id, pieceId, date, result, inspector',
      })
      .upgrade(async (tx) => {
        // 迁移 1：退火窑补装载容量默认值（旧数据没有该字段）
        const capacityByCode = new Map<string, number>()
        const furnaceRows: Record<string, unknown>[] = await tx.table('furnaces').toArray()
        for (const row of furnaceRows) {
          const code = typeof row.code === 'string' ? row.code : ''
          const capacity = typeof row.loadCapacity === 'number' && row.loadCapacity > 0
            ? Math.floor(row.loadCapacity)
            : DEFAULT_ANNEAL_CAPACITY
          row.loadCapacity = capacity
          if (code !== '') capacityByCode.set(code, capacity)
          await tx.table('furnaces').put(row)
        }

        // 迁移 2：历史单件退火记录归炉；待入窑记录释放窑位回到排队
        const legacyAnneals: Record<string, unknown>[] = await tx.table('anneals').toArray()
        const seqByCode: Record<string, number> = {}
        const sorted = [...legacyAnneals].sort((a, b) =>
          String(a.inAt ?? '').localeCompare(String(b.inAt ?? '')),
        )
        for (const row of sorted) {
          if (typeof row.batchId !== 'string') row.batchId = ''
          if (typeof row.kilnSlot !== 'string') row.kilnSlot = ''
          if (typeof row.outAt !== 'string') row.outAt = ''
          const slot = String(row.kilnSlot ?? '')
          const state = String(row.state ?? '')
          if (state !== '待入窑' && slot !== '') {
            const code = slot.split('-').slice(0, -1).join('-')
            seqByCode[code] = (seqByCode[code] ?? 0) + 1
            const stamp = nowIso()
            const legacyBatch = {
              id: `kilnbatch-legacy-${String(row.id)}`,
              kilnCode: code,
              seq: seqByCode[code],
              curveSeg: typeof row.curveSeg === 'string' && row.curveSeg !== '' ? row.curveSeg : '缓冷',
              inAt: typeof row.inAt === 'string' ? row.inAt : stamp,
              outAt: typeof row.outAt === 'string' ? row.outAt : '',
              state: state === '已出炉' ? '已出炉' : '退火中',
              capacity: capacityByCode.get(code) ?? DEFAULT_ANNEAL_CAPACITY,
              slots: [slot],
              keeper: '',
              outCount: state === '已出炉' ? 1 : null,
              mismatchNote: '由升级前的单件退火记录迁移归炉',
              createdAt: stamp,
              updatedAt: stamp,
              revision: ROW_REVISION,
            }
            await tx.table('kilnBatches').put(legacyBatch)
            row.batchId = legacyBatch.id
          } else {
            // 待入窑：退回排队，释放预占窑位，保留期望入窑时间与曲线
            row.batchId = ''
            row.kilnSlot = ''
          }
          await tx.table('anneals').put(row)
        }
      })
  }
}

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

/** 删除窑炉：级联清理该窑下的料液批次；退火窑则把未出炉炉次退回排队 */
export async function removeFurnace(id: string): Promise<void> {
  const furnace = await db.furnaces.get(id)
  await db.transaction(
    'rw',
    db.furnaces,
    db.batches,
    db.kilnBatches,
    db.anneals,
    db.pieces,
    async () => {
      await db.batches.where('furnaceId').equals(id).delete()
      if (furnace?.type === '退火窑') {
        const batches = await db.kilnBatches.where('kilnCode').equals(furnace.code).toArray()
        for (const batch of batches) {
          if (batch.state === '已出炉') continue
          await db.anneals.where('batchId').equals(batch.id).modify({
            batchId: '',
            kilnSlot: '',
            inAt: '',
            state: '待入窑',
            outAt: '',
            updatedAt: nowIso(),
          })
          await db.kilnBatches.delete(batch.id)
        }
      }
      await db.furnaces.delete(id)
    },
  )
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

/** 删除作品：级联清理工序、退火与检验记录；若其退离未出炉炉次，则把空炉炉次一并清掉 */
export async function removePiece(id: string): Promise<void> {
  await db.transaction(
    'rw',
    db.pieces,
    db.steps,
    db.anneals,
    db.kilnBatches,
    db.inspects,
    async () => {
      const anneals = await db.anneals.where('pieceId').equals(id).toArray()
      const openBatchIds = new Set(
        anneals
          .filter((row) => row.batchId !== '')
          .map((row) => row.batchId),
      )
      await db.steps.where('pieceId').equals(id).delete()
      await db.anneals.where('pieceId').equals(id).delete()
      await db.inspects.where('pieceId').equals(id).delete()
      // 删掉作品后空掉的未出炉炉次直接移除（其窑位随之释放）
      for (const batchId of openBatchIds) {
        const remain = await db.anneals.where('batchId').equals(batchId).count()
        if (remain === 0) await db.kilnBatches.delete(batchId)
      }
      await db.pieces.delete(id)
    },
  )
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

/* ------------------------- 退火（排队 + 炉次） ------------------------- */

export async function listAnneals(): Promise<Anneal[]> {
  const rows = await db.anneals.toArray()
  return rows.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
}

export async function listAnnealsByPiece(pieceId: string): Promise<Anneal[]> {
  return db.anneals.where('pieceId').equals(pieceId).toArray()
}

export async function listKilnBatches(): Promise<KilnBatch[]> {
  const rows = await db.kilnBatches.toArray()
  return rows.sort((a, b) => a.inAt.localeCompare(b.inAt) || a.seq - b.seq)
}

/** 排队登记一件待入窑作品（尚未分配窑炉 / 窑位 / 实际时间） */
export async function putAnneal(row: Anneal): Promise<void> {
  await db.anneals.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION })
  await syncPieceState(row.pieceId)
}

/**
 * 删除退火记录：
 * - 待入窑排队记录直接删除；
 * - 已入炉（退火中 / 已出炉）记录不允许从炉次里抽走，需整炉值守处理。
 */
export async function removeAnneal(id: string): Promise<boolean> {
  const row = await db.anneals.get(id)
  if (!row) return false
  if (row.batchId !== '' && row.state !== '待入窑') return false
  await db.transaction('rw', db.anneals, db.kilnBatches, async () => {
    await db.anneals.delete(id)
    if (row.batchId !== '') {
      const remain = await db.anneals.where('batchId').equals(row.batchId).count()
      if (remain === 0) await db.kilnBatches.delete(row.batchId)
    }
  })
  await syncPieceState(row.pieceId)
  return true
}

export interface NewKilnBatchInput {
  kilnCode: string
  curveSeg: CurveSeg
  inAt: string
  /** 退火窑容量快照（件） */
  capacity: number
  keeper: string
  /** 本炉装入的退火记录 id（顺序即窑位顺序） */
  annealIds: string[]
  /** 与 annealIds 一一对应的窑位 */
  slots: string[]
}

/**
 * 组炉：把曲线相同、时间能对上的待入窑作品并成一炉，共用一组窑位。
 * 新炉保持「待入窑」（已排炉、待值守确认实际入窑），占用窑位参与判重。
 */
export async function createKilnBatch(input: NewKilnBatchInput): Promise<KilnBatch> {
  if (input.annealIds.length === 0 || input.annealIds.length !== input.slots.length) {
    throw new Error('炉次必须至少装入 1 件作品，且窑位与作品一一对应。')
  }
  const stamp = nowIso()
  return db.transaction('rw', db.kilnBatches, db.anneals, db.pieces, async () => {
    const seq = (await db.kilnBatches.where('kilnCode').equals(input.kilnCode).count()) + 1
    const batch: KilnBatch = {
      id: `kilnbatch-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`,
      kilnCode: input.kilnCode,
      seq,
      curveSeg: input.curveSeg,
      inAt: input.inAt,
      outAt: '',
      state: '待入窑',
      capacity: Math.max(1, Math.floor(input.capacity)),
      slots: [...input.slots],
      keeper: input.keeper.trim(),
      outCount: null,
      mismatchNote: '',
      createdAt: stamp,
      updatedAt: stamp,
      revision: ROW_REVISION,
    }
    await db.kilnBatches.put(batch)
    for (let index = 0; index < input.annealIds.length; index += 1) {
      const annealId = input.annealIds[index]
      const anneal = await db.anneals.get(annealId)
      if (!anneal) throw new Error('待入炉作品的退火记录不存在，组炉已取消。')
      if (anneal.state !== '待入窑' || anneal.batchId !== '') {
        throw new Error(`作品已被排入别的炉次或已入炉，不能重复组炉：${annealId}`)
      }
      if (anneal.curveSeg !== input.curveSeg) throw new Error('只有曲线相同的作品才能并成一炉。')
      await db.anneals.update(annealId, {
        batchId: batch.id,
        kilnSlot: input.slots[index],
        inAt: input.inAt,
        state: '待入窑',
        outAt: '',
        updatedAt: stamp,
      })
    }
    return batch
  })
}

/** 更新尚未入窑炉次的值守人（计划备注） */
export async function updateKilnBatchKeeper(batchId: string, keeper: string): Promise<void> {
  await db.kilnBatches.update(batchId, { keeper: keeper.trim(), updatedAt: nowIso() })
}

/**
 * 退火值守：登记一炉实际入窑，整炉推进为「退火中」，写入实际入窑时间与值守人。
 * 已入窑（退火中 / 已出炉）的炉次不能重复确认。
 */
export async function markBatchLoaded(batchId: string, inAt: string, keeper: string): Promise<boolean> {
  const batch = await db.kilnBatches.get(batchId)
  if (!batch || batch.state !== '待入窑') return false
  const stamp = nowIso()
  await db.transaction('rw', db.kilnBatches, db.anneals, async () => {
    await db.kilnBatches.update(batchId, {
      inAt,
      keeper: keeper.trim(),
      state: '退火中',
      outCount: null,
      mismatchNote: '',
      updatedAt: stamp,
    })
    await db.anneals.where('batchId').equals(batchId).modify({
      inAt,
      state: '退火中',
      outAt: '',
      updatedAt: stamp,
    })
  })
  return true
}

export interface BatchOutInput {
  outAt: string
  /** 值守清点的实际出炉件数；与炉内件数不一致时须填写 mismatchNote */
  outCount: number
  mismatchNote: string
}

/**
 * 退火值守：登记一炉实际出炉，整炉推进为「已出炉」并回写各作品状态。
 * 烧完件数对不上（实际出炉件数 ≠ 炉内件数）时必须在炉次上写明情况说明。
 */
export async function markBatchOut(batchId: string, input: BatchOutInput): Promise<{ ok: boolean; message: string }> {
  const batch = await db.kilnBatches.get(batchId)
  if (!batch) return { ok: false, message: '炉次不存在。' }
  if (batch.state === '已出炉') return { ok: false, message: '该炉已经登记过出炉。' }
  const members = await db.anneals.where('batchId').equals(batchId).toArray()
  if (members.length === 0) return { ok: false, message: '炉内没有作品，无法登记出炉。' }
  if (input.outCount !== members.length && input.mismatchNote.trim() === '') {
    return { ok: false, message: `实际出炉 ${input.outCount} 件与炉内 ${members.length} 件不一致，必须在炉次上写明情况说明。` }
  }
  const stamp = nowIso()
  await db.transaction(
    'rw',
    db.kilnBatches,
    db.anneals,
    db.pieces,
    db.steps,
    db.inspects,
    async () => {
      await db.kilnBatches.update(batchId, {
        state: '已出炉',
        outAt: input.outAt,
        outCount: input.outCount,
        mismatchNote: input.mismatchNote.trim(),
        updatedAt: stamp,
      })
      await db.anneals.where('batchId').equals(batchId).modify({
        state: '已出炉',
        outAt: input.outAt,
        updatedAt: stamp,
      })
      for (const member of members) {
        await syncPieceState(member.pieceId)
      }
    },
  )
  return { ok: true, message: input.outCount === members.length ? '出炉件数与炉内一致。' : '已登记出炉并记录件数差异说明。' }
}

/** 删除尚未入窑（待入窑排炉）的炉次：作品退回待入窑排队、释放窑位；已入窑炉次禁止删除 */
export async function removeKilnBatch(batchId: string): Promise<boolean> {
  const batch = await db.kilnBatches.get(batchId)
  if (!batch) return false
  if (batch.state !== '待入窑') return false
  await db.transaction('rw', db.kilnBatches, db.anneals, async () => {
    await db.anneals.where('batchId').equals(batchId).modify({
      batchId: '',
      kilnSlot: '',
      state: '待入窑',
      updatedAt: nowIso(),
    })
    await db.kilnBatches.delete(batchId)
  })
  return true
}

/**
 * 作品壁厚改动后，把该作品尚未入窑（排队 / 待入窑排炉）的退火安排退回待入窑重排：
 * 已入炉（退火中 / 已出炉）的按原样烧完、不动。
 * 返回被退回重排的退火记录数。
 */
export async function requeueOpenAnnealsForPiece(pieceId: string): Promise<number> {
  const anneals = await db.anneals.where('pieceId').equals(pieceId).toArray()
  const open = anneals.filter((row) => row.state === '待入窑')
  if (open.length === 0) return 0
  const emptyBatchIds = new Set<string>()
  await db.transaction('rw', db.anneals, db.kilnBatches, async () => {
    for (const row of open) {
      if (row.batchId !== '') emptyBatchIds.add(row.batchId)
      await db.anneals.update(row.id, {
        batchId: '',
        kilnSlot: '',
        state: '待入窑',
        updatedAt: nowIso(),
      })
    }
    for (const batchId of emptyBatchIds) {
      const remain = await db.anneals.where('batchId').equals(batchId).count()
      const batch = await db.kilnBatches.get(batchId)
      // 整炉都被退回（只可能发生在待入窑炉次）时删掉炉次，释放整组窑位
      if (remain === 0 && batch?.state === '待入窑') {
        await db.kilnBatches.delete(batchId)
      } else if (batch?.state === '待入窑') {
        // 炉里还有别的作品：缩小窑位组，仍按原炉烧
        const members = await db.anneals.where('batchId').equals(batchId).toArray()
        await db.kilnBatches.update(batchId, {
          slots: members.map((member) => member.kilnSlot).filter((slot) => slot !== ''),
          updatedAt: nowIso(),
        })
      }
    }
  })
  return open.length
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
  kilnBatches: KilnBatch[]
  anneals: Anneal[]
  inspects: Inspect[]
}

export async function exportSnapshot(): Promise<DatabaseSnapshot> {
  const [furnaces, batches, pieces, steps, kilnBatches, anneals, inspects] = await Promise.all([
    db.furnaces.toArray(),
    db.batches.toArray(),
    db.pieces.toArray(),
    db.steps.toArray(),
    db.kilnBatches.toArray(),
    db.anneals.toArray(),
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
    kilnBatches,
    anneals,
    inspects,
  }
}

export async function importSnapshot(snapshot: DatabaseSnapshot): Promise<void> {
  await db.transaction(
    'rw',
    [db.furnaces, db.batches, db.pieces, db.steps, db.kilnBatches, db.anneals, db.inspects],
    async () => {
      await Promise.all([
        db.furnaces.clear(),
        db.batches.clear(),
        db.pieces.clear(),
        db.steps.clear(),
        db.kilnBatches.clear(),
        db.anneals.clear(),
        db.inspects.clear(),
      ])
      await db.furnaces.bulkPut(snapshot.furnaces.map((row) => ({ ...row, revision: ROW_REVISION })))
      await db.batches.bulkPut(snapshot.batches.map((row) => ({ ...row, revision: ROW_REVISION })))
      await db.pieces.bulkPut(snapshot.pieces.map((row) => ({ ...row, revision: ROW_REVISION })))
      await db.steps.bulkPut(snapshot.steps.map((row) => ({ ...row, revision: ROW_REVISION })))
      await db.kilnBatches.bulkPut((snapshot.kilnBatches ?? []).map((row) => ({ ...row, revision: ROW_REVISION })))
      await db.anneals.bulkPut(snapshot.anneals.map((row) => ({ ...row, revision: ROW_REVISION })))
      await db.inspects.bulkPut(snapshot.inspects.map((row) => ({ ...row, revision: ROW_REVISION })))
    },
  )
}

export async function resetDatabase(): Promise<void> {
  await db.transaction(
    'rw',
    [db.furnaces, db.batches, db.pieces, db.steps, db.kilnBatches, db.anneals, db.inspects],
    async () => {
      await Promise.all([
        db.furnaces.clear(),
        db.batches.clear(),
        db.pieces.clear(),
        db.steps.clear(),
        db.kilnBatches.clear(),
        db.anneals.clear(),
        db.inspects.clear(),
      ])
    },
  )
  await seedDatabase()
}

export async function countAll(): Promise<Record<string, number>> {
  const [furnaces, batches, pieces, steps, kilnBatches, anneals, inspects] = await Promise.all([
    db.furnaces.count(),
    db.batches.count(),
    db.pieces.count(),
    db.steps.count(),
    db.kilnBatches.count(),
    db.anneals.count(),
    db.inspects.count(),
  ])
  return { furnaces, batches, pieces, steps, kilnBatches, anneals, inspects }
}
