// 记录存储层：发条释放单 / 扭矩曲线 / 复测记录的持久化与并发互斥。
// 业务判定一律不放在这里，由 src/releaseRules.js 负责。
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
  releaseOrders: [
    {
      id: "release_demo",
      clockId: "clock_demo",
      revisionOfId: null,
      reason: "initial",
      fullWindTorque: 10,
      residualTorque: 0.8,
      restingMinutes: 30,
      operator: "陈师傅",
      note: "拆机前发条扭矩释放登记，曲线末三次回升待换人复测",
      createdAt: "2026-06-16T00:00:00.000Z"
    }
  ],
  releaseCurves: [
    {
      id: "curve_demo",
      clockId: "clock_demo",
      orderId: "release_demo",
      torques: [9.2, 8.4, 7.6, 6.8, 7.1, 6.9],
      testedAt: "2026-06-16T00:30:00.000Z"
    }
  ],
  releaseRetests: []
};

// 每只表一把串行锁：创建/登记等写操作在同一钟表维度排队，
// 并发提交只会让首个请求落库，其余沿用首次结果。
const clockLocks = new Map();

function withClockLock(clockId, task) {
  const prev = clockLocks.get(clockId) || Promise.resolve();
  const run = prev.then(() => task());
  // 队列尾部吞掉错误，保证后续请求不会被前一个失败永久阻塞。
  const tail = run.then(() => undefined, () => undefined);
  clockLocks.set(clockId, tail);
  tail.then(() => {
    // 仅当没有更新的任务入队时才摘掉锁。
    if (clockLocks.get(clockId) === tail) clockLocks.delete(clockId);
  });
  return run;
}

async function ensureDb() {
  await mkdir(path.dirname(DB_FILE), { recursive: true });
  try {
    const db = JSON.parse(await readFile(DB_FILE, "utf8"));
    // 旧数据文件补全新集合，保持兼容。
    for (const key of Object.keys(initialData)) {
      if (!Array.isArray(db[key])) db[key] = [];
    }
    return db;
  } catch {
    await writeFile(DB_FILE, JSON.stringify(initialData, null, 2));
    return JSON.parse(JSON.stringify(initialData));
  }
}

async function readDb() {
  return ensureDb();
}

async function writeDb(db) {
  await writeFile(DB_FILE, JSON.stringify(db, null, 2));
}

function makeId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

module.exports = {
  DB_FILE,
  initialData,
  withClockLock,
  readDb,
  writeDb,
  makeId
};
