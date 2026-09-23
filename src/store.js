"use strict";

// 记录存储：data/db.json 持久化、写互斥、业务查询。
// 判定规则不放在这里，见 rules.js；HTTP 解析不放在这里，见 routes.js。

const { readFile, writeFile, mkdir } = require("fs/promises");
const path = require("path");

const DB_FILE = path.join(__dirname, "..", "data", "db.json");

const initialData = {
  clocks: [
    {
      id: "clock_demo",
      code: "CLK-1890-07",
      escapementType: "瑞士杠杆式",
      balanceFrequency: "18000vph",
      targetDailyRateSeconds: 20,
      note: "怀表机芯，走时偏快",
      createdAt: "2026-06-16T00:00:00.000Z"
    }
  ],
  adjustments: [
    {
      id: "adjustment_demo",
      clockId: "clock_demo",
      currentDailyRateSeconds: 68,
      direction: "慢针方向",
      amount: "游丝快慢针向慢侧微调0.4格",
      note: "初次调校，先保守处理",
      createdAt: "2026-06-16T00:00:00.000Z"
    }
  ],
  retests: [
    {
      id: "retest_demo",
      clockId: "clock_demo",
      adjustmentId: "adjustment_demo",
      testedAt: "2026-06-16T00:00:00.000Z",
      dailyRateSeconds: 31,
      amplitude: 248,
      qualified: false,
      note: "仍偏快，振幅尚可"
    }
  ],
  // 发条扭矩释放单（每个版本一条；换发条/更正释放值会新增版本，旧单只读）
  releaseOrders: [
    {
      id: "release_demo_v1",
      clockId: "clock_demo",
      version: 1,
      replacesOrderId: null,
      reason: null,
      fullWindTorque: 320,
      residualTorque: 20,
      restingMinutes: 45,
      releasedBy: "王师傅",
      note: "示例：满弦释放后曲线单调，已准入",
      status: "closed",
      closeReason: "approved",
      superseded: false,
      supersededByOrderId: null,
      createdAt: "2026-06-16T01:00:00.000Z",
      closedAt: "2026-06-16T03:30:00.000Z"
    }
  ],
  // 释放后六个时点的扭矩读数
  torqueReadings: [
    { id: "tr_demo_1", orderId: "release_demo_v1", clockId: "clock_demo", point: 1, torque: 305, measuredAt: "2026-06-16T01:30:00.000Z", recordedBy: "王师傅", createdAt: "2026-06-16T01:30:00.000Z" },
    { id: "tr_demo_2", orderId: "release_demo_v1", clockId: "clock_demo", point: 2, torque: 272, measuredAt: "2026-06-16T02:00:00.000Z", recordedBy: "王师傅", createdAt: "2026-06-16T02:00:00.000Z" },
    { id: "tr_demo_3", orderId: "release_demo_v1", clockId: "clock_demo", point: 3, torque: 244, measuredAt: "2026-06-16T02:30:00.000Z", recordedBy: "王师傅", createdAt: "2026-06-16T02:30:00.000Z" },
    { id: "tr_demo_4", orderId: "release_demo_v1", clockId: "clock_demo", point: 4, torque: 216, measuredAt: "2026-06-16T03:00:00.000Z", recordedBy: "王师傅", createdAt: "2026-06-16T03:00:00.000Z" },
    { id: "tr_demo_5", orderId: "release_demo_v1", clockId: "clock_demo", point: 5, torque: 190, measuredAt: "2026-06-16T03:15:00.000Z", recordedBy: "王师傅", createdAt: "2026-06-16T03:15:00.000Z" },
    { id: "tr_demo_6", orderId: "release_demo_v1", clockId: "clock_demo", point: 6, torque: 166, measuredAt: "2026-06-16T03:30:00.000Z", recordedBy: "王师傅", createdAt: "2026-06-16T03:30:00.000Z" }
  ],
  // 曲线后三次回升后的换人复测
  releaseRetests: []
};

async function ensureDb() {
  await mkdir(path.dirname(DB_FILE), { recursive: true });
  try {
    JSON.parse(await readFile(DB_FILE, "utf8"));
  } catch {
    await writeFile(DB_FILE, JSON.stringify(initialData, null, 2));
  }
}

// 旧库可能没有新集合，读出时补齐空数组（首次写回时落盘）
function normalize(db) {
  const normalized = { ...db };
  for (const key of Object.keys(initialData)) {
    if (!Array.isArray(normalized[key])) normalized[key] = JSON.parse(JSON.stringify(initialData[key]));
  }
  return normalized;
}

async function readDb() {
  await ensureDb();
  return normalize(JSON.parse(await readFile(DB_FILE, "utf8")));
}

async function saveDb(data) {
  await writeFile(DB_FILE, JSON.stringify(data, null, 2));
}

// 全局写互斥：把“读-改-写”串行化，杜绝并发提交互相覆盖，
// 也让“每只表仅一张未结束释放单”的并发判定成立。
let writeChain = Promise.resolve();
function withWrite(task) {
  const run = writeChain.then(() => task());
  writeChain = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

function findClock(db, clockId) {
  return db.clocks.find((item) => item.id === clockId) || null;
}

function findReleaseOrder(db, orderId) {
  return db.releaseOrders.find((item) => item.id === orderId) || null;
}

// 一只表至多一张未结束（open）释放单
function getOpenReleaseOrder(db, clockId) {
  return db.releaseOrders.find((item) => item.clockId === clockId && item.status === "open") || null;
}

// 最新版本（换发条/更正后版本号递增）
function getLatestReleaseOrder(db, clockId) {
  return (
    db.releaseOrders
      .filter((item) => item.clockId === clockId)
      .sort((a, b) => b.version - a.version)[0] || null
  );
}

function orderReadings(db, orderId) {
  return db.torqueReadings
    .filter((item) => item.orderId === orderId)
    .sort((a, b) => a.point - b.point);
}

function orderRetests(db, orderId) {
  return db.releaseRetests
    .filter((item) => item.orderId === orderId)
    .sort((a, b) => new Date(a.measuredAt) - new Date(b.measuredAt));
}

function latestRetest(db, clockId) {
  return db.retests
    .filter((item) => item.clockId === clockId)
    .sort((a, b) => new Date(b.testedAt) - new Date(a.testedAt))[0] || null;
}

function latestAdjustment(db, clockId) {
  return db.adjustments
    .filter((item) => item.clockId === clockId)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0] || null;
}

module.exports = {
  DB_FILE,
  initialData,
  ensureDb,
  readDb,
  saveDb,
  withWrite,
  findClock,
  findReleaseOrder,
  getOpenReleaseOrder,
  getLatestReleaseOrder,
  orderReadings,
  orderRetests,
  latestRetest,
  latestAdjustment
};
