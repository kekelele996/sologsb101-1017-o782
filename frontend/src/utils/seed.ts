/**
 * 演示数据播种（幂等）
 * 父 → 子 → 孙三层链路：窑炉 → 料液批次 → 作品 → 吹制工序 → 退火 → 出炉检验
 * 所有 id 固定，保证 /pieces/:id/steps 深链一定命中真实作品与工序。
 */
import { db, ROW_REVISION } from './db'
import type { Furnace } from '../types/furnace'
import { DEFAULT_ANNEAL_CAPACITY } from '../types/furnace'
import type { GlassBatch } from '../types/batch'
import type { Piece } from '../types/piece'
import type { Step } from '../types/step'
import type { Anneal } from '../types/anneal'
import type { KilnBatch } from '../types/kilnBatch'
import type { Inspect } from '../types/inspect'

const SEED_TIME = '2026-09-01T02:00:00.000Z'

/** 固定 id，便于文档与深链验证 */
export const SEED_IDS = {
  furnaceMelt: 'furnace-kiln-01',
  furnaceCrucible: 'furnace-kiln-02',
  furnaceAnneal: 'furnace-anneal-01',
  batchAmber: 'batch-g101',
  batchIron: 'batch-a207',
  batchCopper: 'batch-c330',
  batchClear: 'batch-t045',
  pieceMorning: 'piece-morning-vase',
  pieceGreen: 'piece-green-bowl',
  piecePaperweight: 'piece-sunset-weight',
  pieceBottle: 'piece-frost-bottle',
  pieceCup: 'piece-red-cup',
  pieceLantern: 'piece-amber-lantern',
} as const

function wrap<T>(row: Omit<T, 'createdAt' | 'updatedAt' | 'revision'>): T {
  return { ...row, createdAt: SEED_TIME, updatedAt: SEED_TIME, revision: ROW_REVISION } as T
}

export async function seedDatabase(): Promise<void> {
  const exists = await db.furnaces.count()
  if (exists > 0) return

  // ---------------- 窑炉（2 台熔化/坩埚炉 + 1 台退火窑，每炉最多装 6 件） ----------------
  const furnaces: Furnace[] = [
    wrap<Furnace>({ id: SEED_IDS.furnaceMelt, code: 'KILN-01', type: '熔化炉', maxTempC: 1250, fuelType: '燃气', state: '运行', loadCapacity: DEFAULT_ANNEAL_CAPACITY }),
    wrap<Furnace>({ id: SEED_IDS.furnaceCrucible, code: 'KILN-02', type: '坩埚炉', maxTempC: 1180, fuelType: '电', state: '保温', loadCapacity: DEFAULT_ANNEAL_CAPACITY }),
    wrap<Furnace>({ id: SEED_IDS.furnaceAnneal, code: 'AN-01', type: '退火窑', maxTempC: 620, fuelType: '电', state: '运行', loadCapacity: 6 }),
  ]

  // ---------------- 料液批次（每窑 2 批，含一批低于补料阈值） ----------------
  const batches: GlassBatch[] = [
    wrap<GlassBatch>({ id: SEED_IDS.batchAmber, furnaceId: SEED_IDS.furnaceMelt, colorCode: 'G-101', recipe: '钠钙玻璃基础料 + 氧化钴 0.3%', meltDate: '2026-09-12', tempC: 1180, remainKg: 268 }),
    wrap<GlassBatch>({ id: SEED_IDS.batchIron, furnaceId: SEED_IDS.furnaceMelt, colorCode: 'A-207', recipe: '钠钙玻璃基础料 + 氧化铁 1.2%', meltDate: '2026-08-28', tempC: 1165, remainKg: 42 }),
    wrap<GlassBatch>({ id: SEED_IDS.batchCopper, furnaceId: SEED_IDS.furnaceCrucible, colorCode: 'C-330', recipe: '钾铅玻璃 + 氧化铜 0.8%', meltDate: '2026-09-18', tempC: 1120, remainKg: 156 }),
    wrap<GlassBatch>({ id: SEED_IDS.batchClear, furnaceId: SEED_IDS.furnaceCrucible, colorCode: 'T-045', recipe: '高透钠钙玻璃（无着色剂）', meltDate: '2026-09-05', tempC: 1170, remainKg: 88 }),
  ]

  // ---------------- 作品（5 件，覆盖四种状态与三种工艺） ----------------
  const pieces: Piece[] = [
    wrap<Piece>({ id: SEED_IDS.pieceMorning, name: '晨雾花器', batchId: SEED_IDS.batchAmber, designHeightMm: 260, wallThicknessMm: 4.5, craft: '吹制', artist: '林曦', state: '制作中' }),
    wrap<Piece>({ id: SEED_IDS.pieceGreen, name: '叠翠碗', batchId: SEED_IDS.batchCopper, designHeightMm: 180, wallThicknessMm: 6, craft: '铸造', artist: '沈沐', state: '已检验' }),
    wrap<Piece>({ id: SEED_IDS.piecePaperweight, name: '流霞镇纸', batchId: SEED_IDS.batchIron, designHeightMm: 120, wallThicknessMm: 8, craft: '热塑', artist: '郑野', state: '制作中' }),
    wrap<Piece>({ id: SEED_IDS.pieceBottle, name: '霜白长颈瓶', batchId: SEED_IDS.batchClear, designHeightMm: 340, wallThicknessMm: 3.2, craft: '吹制', artist: '林曦', state: '已检验' }),
    wrap<Piece>({ id: SEED_IDS.pieceCup, name: '赤霞杯', batchId: SEED_IDS.batchAmber, designHeightMm: 95, wallThicknessMm: 3.5, craft: '吹制', artist: '沈沐', state: '已退火' }),
    wrap<Piece>({ id: SEED_IDS.pieceLantern, name: '琥珀风灯', batchId: SEED_IDS.batchCopper, designHeightMm: 220, wallThicknessMm: 5, craft: '铸造', artist: '郑野', state: '制作中' }),
  ]

  // ---------------- 吹制工序（每件 2–5 道，seq 连续） ----------------
  const steps: Step[] = [
    wrap<Step>({ id: 'step-m1', pieceId: SEED_IDS.pieceMorning, seq: 1, name: '取料', tempC: 1180, durationMin: 3.5, operator: '林曦', remark: '取 G-101 料液约 6.2 kg', state: '已完成' }),
    wrap<Step>({ id: 'step-m2', pieceId: SEED_IDS.pieceMorning, seq: 2, name: '吹制', tempC: 1120, durationMin: 6, operator: '林曦', remark: '分三次吹气成型', state: '已完成' }),
    wrap<Step>({ id: 'step-m3', pieceId: SEED_IDS.pieceMorning, seq: 3, name: '塑形', tempC: 980, durationMin: 8.5, operator: '沈沐', remark: '夹持颈部收细', state: '已完成' }),
    wrap<Step>({ id: 'step-m4', pieceId: SEED_IDS.pieceMorning, seq: 4, name: '收口', tempC: 860, durationMin: 4, operator: '林曦', remark: '口沿回火处理', state: '已完成' }),
    wrap<Step>({ id: 'step-g1', pieceId: SEED_IDS.pieceGreen, seq: 1, name: '取料', tempC: 1120, durationMin: 4, operator: '沈沐', remark: '取 C-330 料液约 9.5 kg', state: '已完成' }),
    wrap<Step>({ id: 'step-g2', pieceId: SEED_IDS.pieceGreen, seq: 2, name: '开模', tempC: 940, durationMin: 12, operator: '沈沐', remark: '石膏模浇注', state: '已完成' }),
    wrap<Step>({ id: 'step-g3', pieceId: SEED_IDS.pieceGreen, seq: 3, name: '塑形', tempC: 900, durationMin: 9, operator: '郑野', remark: '修整碗口与底足', state: '已完成' }),
    wrap<Step>({ id: 'step-p1', pieceId: SEED_IDS.piecePaperweight, seq: 1, name: '取料', tempC: 1160, durationMin: 2.5, operator: '郑野', remark: '取 A-207 料液约 3.1 kg', state: '已完成' }),
    wrap<Step>({ id: 'step-p2', pieceId: SEED_IDS.piecePaperweight, seq: 2, name: '塑形', tempC: 1020, durationMin: 7, operator: '郑野', remark: '压制成型后回火', state: '进行中' }),
    wrap<Step>({ id: 'step-b1', pieceId: SEED_IDS.pieceBottle, seq: 1, name: '取料', tempC: 1170, durationMin: 3, operator: '林曦', remark: '取 T-045 料液约 7.8 kg', state: '已完成' }),
    wrap<Step>({ id: 'step-b2', pieceId: SEED_IDS.pieceBottle, seq: 2, name: '吹制', tempC: 1110, durationMin: 7.5, operator: '林曦', remark: '长颈一次吹成', state: '已完成' }),
    wrap<Step>({ id: 'step-b3', pieceId: SEED_IDS.pieceBottle, seq: 3, name: '塑形', tempC: 990, durationMin: 10, operator: '沈沐', remark: '拉长颈部至 340 mm', state: '已完成' }),
    wrap<Step>({ id: 'step-b4', pieceId: SEED_IDS.pieceBottle, seq: 4, name: '开模', tempC: 900, durationMin: 6, operator: '郑野', remark: '脱模检查瓶身', state: '已完成' }),
    wrap<Step>({ id: 'step-b5', pieceId: SEED_IDS.pieceBottle, seq: 5, name: '收口', tempC: 840, durationMin: 5, operator: '林曦', remark: '口沿打磨回火', state: '已完成' }),
    wrap<Step>({ id: 'step-c1', pieceId: SEED_IDS.pieceCup, seq: 1, name: '取料', tempC: 1180, durationMin: 3, operator: '沈沐', remark: '取 G-101 料液约 2.4 kg', state: '已完成' }),
    wrap<Step>({ id: 'step-c2', pieceId: SEED_IDS.pieceCup, seq: 2, name: '吹制', tempC: 1130, durationMin: 5.5, operator: '沈沐', remark: '杯身一次成型', state: '已完成' }),
    wrap<Step>({ id: 'step-c3', pieceId: SEED_IDS.pieceCup, seq: 3, name: '塑形', tempC: 1000, durationMin: 8, operator: '林曦', remark: '接杯柄并回火', state: '已完成' }),
    wrap<Step>({ id: 'step-l1', pieceId: SEED_IDS.pieceLantern, seq: 1, name: '取料', tempC: 1100, durationMin: 5, operator: '郑野', remark: '取 C-330 料液约 8 kg', state: '已完成' }),
    wrap<Step>({ id: 'step-l2', pieceId: SEED_IDS.pieceLantern, seq: 2, name: '开模', tempC: 930, durationMin: 14, operator: '郑野', remark: '风灯分体模浇注', state: '已完成' }),
    wrap<Step>({ id: 'step-l3', pieceId: SEED_IDS.pieceLantern, seq: 3, name: '收口', tempC: 860, durationMin: 6, operator: '沈沐', remark: '顶口修圆回火', state: '已完成' }),
  ]

  // ---------------- 退火炉次（3 炉，演示并炉 / 容量 / 出炉件数对不上） ----------------
  const kilnBatches: KilnBatch[] = [
    // 第 1 炉：叠翠碗 + 霜白长颈瓶 曲线相同并炉，已出炉，件数一致
    wrap<KilnBatch>({
      id: 'kilnbatch-seed-1',
      kilnCode: 'AN-01',
      seq: 1,
      curveSeg: '缓冷',
      inAt: '2026-09-20T09:00',
      outAt: '2026-09-21T12:00',
      state: '已出炉',
      capacity: 6,
      slots: ['AN-01-A1', 'AN-01-A2'],
      keeper: '吴岚',
      outCount: 2,
      mismatchNote: '',
    }),
    // 第 2 炉：赤霞杯 + 晨雾花器 升温段并炉，退火中
    wrap<KilnBatch>({
      id: 'kilnbatch-seed-2',
      kilnCode: 'AN-01',
      seq: 2,
      curveSeg: '升温',
      inAt: '2026-10-02T14:00',
      outAt: '',
      state: '退火中',
      capacity: 6,
      slots: ['AN-01-B1', 'AN-01-B2'],
      keeper: '郑野',
      outCount: null,
      mismatchNote: '',
    }),
    // 第 3 炉：流霞镇纸已排炉待入窑（演示不挤占在烧炉次，与第 2 炉错窑位）
    wrap<KilnBatch>({
      id: 'kilnbatch-seed-3',
      kilnCode: 'AN-01',
      seq: 3,
      curveSeg: '保温',
      inAt: '2026-10-03T20:00',
      outAt: '',
      state: '待入窑',
      capacity: 6,
      slots: ['AN-01-C1'],
      keeper: '郑野',
      outCount: null,
      mismatchNote: '',
    }),
  ]

  // ---------------- 退火（每件归属炉次、在炉内各占一格；另留一件排队） ----------------
  const anneals: Anneal[] = [
    wrap<Anneal>({ id: 'anneal-g1', pieceId: SEED_IDS.pieceGreen, batchId: 'kilnbatch-seed-1', kilnSlot: 'AN-01-A1', curveSeg: '缓冷', inAt: '2026-09-20T09:00', outAt: '2026-09-21T12:00', state: '已出炉' }),
    wrap<Anneal>({ id: 'anneal-b1', pieceId: SEED_IDS.pieceBottle, batchId: 'kilnbatch-seed-1', kilnSlot: 'AN-01-A2', curveSeg: '缓冷', inAt: '2026-09-20T09:00', outAt: '2026-09-21T12:00', state: '已出炉' }),
    wrap<Anneal>({ id: 'anneal-c1', pieceId: SEED_IDS.pieceCup, batchId: 'kilnbatch-seed-2', kilnSlot: 'AN-01-B1', curveSeg: '升温', inAt: '2026-10-02T14:00', outAt: '', state: '退火中' }),
    wrap<Anneal>({ id: 'anneal-m1', pieceId: SEED_IDS.pieceMorning, batchId: 'kilnbatch-seed-2', kilnSlot: 'AN-01-B2', curveSeg: '升温', inAt: '2026-10-02T14:00', outAt: '', state: '退火中' }),
    wrap<Anneal>({ id: 'anneal-p1', pieceId: SEED_IDS.piecePaperweight, batchId: 'kilnbatch-seed-3', kilnSlot: 'AN-01-C1', curveSeg: '保温', inAt: '2026-10-03T20:00', outAt: '', state: '待入窑' }),
    // 琥珀风灯仍在待入窑排队：曲线 / 时间等下一炉，尚未分配窑位
    wrap<Anneal>({ id: 'anneal-l1', pieceId: SEED_IDS.pieceLantern, batchId: '', kilnSlot: '', curveSeg: '保温', inAt: '2026-10-03T18:00', outAt: '', state: '待入窑' }),
  ]

  // ---------------- 出炉检验（2–3 条，含不合格与返工后复检合格） ----------------
  const inspects: Inspect[] = [
    wrap<Inspect>({ id: 'inspect-b1', pieceId: SEED_IDS.pieceBottle, result: '合格', defectNote: '', inspector: '吴岚', date: '2026-09-22' }),
    wrap<Inspect>({ id: 'inspect-g1', pieceId: SEED_IDS.pieceGreen, result: '裂纹', defectNote: '口沿下方 12 mm 处有细裂纹，需回炉修补；原始工序记录保留不变。', inspector: '吴岚', date: '2026-09-22' }),
    wrap<Inspect>({ id: 'inspect-g2', pieceId: SEED_IDS.pieceGreen, result: '合格', defectNote: '回炉修补后复检合格。', inspector: '吴岚', date: '2026-09-25' }),
  ]

  await db.transaction('rw', [db.furnaces, db.batches, db.pieces, db.steps, db.kilnBatches, db.anneals, db.inspects], async () => {
    await db.furnaces.bulkPut(furnaces)
    await db.batches.bulkPut(batches)
    await db.pieces.bulkPut(pieces)
    await db.steps.bulkPut(steps)
    await db.kilnBatches.bulkPut(kilnBatches)
    await db.anneals.bulkPut(anneals)
    await db.inspects.bulkPut(inspects)
  })
}
