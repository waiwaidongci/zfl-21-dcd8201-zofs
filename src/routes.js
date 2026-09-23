"use strict";

// 请求入口：HTTP 解析、路由、幂等与并发控制。
// 判定规则见 rules.js，记录存储见 store.js。
// 所有结论由 rules.evaluateOrder / evaluateClock 实时派生，
// 列表、单表履历、刷新后拿到的结论一致。

const {
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
} = require("./store");

const rules = require("./rules");
const {
  TOTAL_POINTS,
  REVISION_REASONS,
  httpError,
  isFiniteNumber,
  validateRegistration,
  evaluateOrder,
  evaluateClock
} = rules;

const routes = [
  "GET /health",
  "GET /clocks",
  "POST /clocks",
  "GET /clocks/not-qualified",
  "GET /clocks/:id/history",
  "POST /clocks/:id/adjustments",
  "POST /clocks/:id/retests",
  "GET /clocks/:id/latest-retest",
  "GET /adjustments",
  "GET /retests",
  "POST /clocks/:id/release-orders",
  "POST /clocks/:id/release-orders/revisions",
  "GET /clocks/:id/release-history",
  "GET /release-orders",
  "GET /release-orders/:id",
  "POST /release-orders/:id/torque-readings",
  "POST /release-orders/:id/retests"
];

function send(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body, null, 2));
}

async function parseBody(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw httpError(400, "请求体必须是合法JSON");
  }
}

function makeId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function required(body, fields) {
  const missing = fields.filter((field) => body[field] === undefined || body[field] === "");
  if (missing.length) throw httpError(400, `缺少字段：${missing.join(", ")}`);
}

function requireClock(db, clockId) {
  const clock = findClock(db, clockId);
  if (!clock) throw httpError(404, "钟表不存在");
  return clock;
}

function requireOrder(db, orderId) {
  const order = findReleaseOrder(db, orderId);
  if (!order) throw httpError(404, "释放单不存在");
  return order;
}

// ---- 视图：结论全部实时计算，不缓存 ----

function releaseContext(db) {
  const readingsByOrder = new Map();
  for (const item of db.torqueReadings) {
    if (!readingsByOrder.has(item.orderId)) readingsByOrder.set(item.orderId, []);
    readingsByOrder.get(item.orderId).push(item);
  }
  const retestsByOrder = new Map();
  for (const item of db.releaseRetests) {
    if (!retestsByOrder.has(item.orderId)) retestsByOrder.set(item.orderId, []);
    retestsByOrder.get(item.orderId).push(item);
  }
  return { readingsByOrder, retestsByOrder };
}

function orderView(db, order, ctx = releaseContext(db)) {
  const readings = ctx.readingsByOrder.get(order.id) || [];
  const retests = ctx.retestsByOrder.get(order.id) || [];
  return {
    ...order,
    readings: [...readings].sort((a, b) => a.point - b.point),
    retests: [...retests].sort((a, b) => new Date(a.measuredAt) - new Date(b.measuredAt)),
    evaluation: evaluateOrder(order, readings, retests)
  };
}

function admissionFor(db, clockId, ctx = releaseContext(db)) {
  return evaluateClock(clockId, db.releaseOrders, ctx.readingsByOrder, ctx.retestsByOrder);
}

function clockSummary(db, clock, ctx = releaseContext(db)) {
  const retest = latestRetest(db, clock.id);
  const adjustment = latestAdjustment(db, clock.id);
  return {
    ...clock,
    latestAdjustment: adjustment,
    latestRetest: retest,
    qualified: retest ? retest.qualified : false,
    release: admissionFor(db, clock.id, ctx)
  };
}

// 存储状态同步：业务结论由规则实时算，这里只把“已无活动结论”的单子落为 closed，
// 使“未结束释放单唯一”与只读控制落盘。
function syncOrderStatus(db, order, ctx = releaseContext(db)) {
  const result = evaluateOrder(
    order,
    ctx.readingsByOrder.get(order.id) || [],
    ctx.retestsByOrder.get(order.id) || []
  );
  if (order.status === "open" && !result.active) {
    order.status = "closed";
    order.closedAt = new Date().toISOString();
    if (result.state === "admitted") {
      order.closeReason = result.clearedByRetests ? "rebound_cleared" : "approved";
    } else {
      order.closeReason = result.state;
    }
  }
  return result;
}

// ---- 发条释放：登记 ----

async function registerRelease(db, clock, body, { revision, reason }) {
  const input = validateRegistration(body);

  if (!revision) {
    // 每只表仅一张未结束释放单：重复或并发提交沿用首次结果
    const existing = getOpenReleaseOrder(db, clock.id);
    if (existing) {
      return { status: 200, reused: true, order: existing };
    }
    // 已有结束版本时，必须显式换发条/更正，不能静默顶掉准入
    const latest = getLatestReleaseOrder(db, clock.id);
    if (latest) {
      throw httpError(
        409,
        "该表已有结束的释放单；更换发条或更正释放值请调用 /clocks/:id/release-orders/revisions",
        { latestOrderId: latest.id, latestVersion: latest.version }
      );
    }
  }

  const previous = revision ? getLatestReleaseOrder(db, clock.id) : null;
  if (revision && !previous) {
    throw httpError(409, "尚无释放单，不能修订；请先登记释放单");
  }

  const nowIso = new Date().toISOString();
  const newId = makeId("release");
  if (previous) {
    // 旧记录只读：只做失效标记，字段不再改动
    previous.superseded = true;
    previous.supersededByOrderId = newId;
    previous.status = "closed";
    previous.closeReason = "superseded";
    previous.closedAt = nowIso;
  }

  const order = {
    id: newId,
    clockId: clock.id,
    version: previous ? previous.version + 1 : 1,
    replacesOrderId: previous ? previous.id : null,
    reason: revision ? reason : null,
    fullWindTorque: input.fullWindTorque,
    residualTorque: input.residualTorque,
    restingMinutes: input.restingMinutes,
    releasedBy: input.releasedBy,
    note: input.note,
    status: "open",
    closeReason: null,
    superseded: false,
    supersededByOrderId: null,
    createdAt: nowIso,
    closedAt: null
  };
  db.releaseOrders.push(order);

  const ctx = releaseContext(db);
  // 残余高于满弦扭矩一成：登记即拒绝拆机并结束单据
  syncOrderStatus(db, order, ctx);

  return { status: 201, reused: false, order, supersededOrder: previous, ctx };
}

// ---- 六个时点扭矩读数 ----

function parseReadingEntries(body) {
  let raw;
  if (Array.isArray(body.readings)) {
    raw = body.readings;
  } else if (Array.isArray(body.torques)) {
    raw = body.torques.map((torque, index) => ({ point: index + 1, torque }));
  } else if (body.point !== undefined || body.torque !== undefined) {
    raw = [{ point: body.point, torque: body.torque, measuredAt: body.measuredAt, recordedBy: body.recordedBy }];
  } else {
    throw httpError(400, "请提供 {point, torque}、{readings:[{point,torque}]} 或 {torques:[...6个值]}");
  }

  const seen = new Set();
  return raw.map((item) => {
    const point = Number(item && item.point);
    const torque = Number(item && item.torque);
    if (!Number.isInteger(point) || point < 1 || point > TOTAL_POINTS) {
      throw httpError(400, `时点必须是 1-${TOTAL_POINTS} 的整数`);
    }
    if (seen.has(point)) throw httpError(400, `请求内时点 ${point} 重复`);
    seen.add(point);
    if (!isFiniteNumber(torque) || torque < 0) throw httpError(400, `时点 ${point} 的扭矩必须是非负数`);
    const measuredAt = item.measuredAt || new Date().toISOString();
    if (Number.isNaN(Date.parse(measuredAt))) throw httpError(400, `时点 ${point} 的 measuredAt 不是合法时间`);
    return {
      point,
      torque,
      measuredAt,
      recordedBy: typeof item.recordedBy === "string" && item.recordedBy.trim() ? item.recordedBy.trim() : undefined
    };
  });
}

// ---- 回升后的换人复测 ----

function parseRetest(body, order) {
  required(body, ["testedBy", "torques"]);
  const testedBy = String(body.testedBy).trim();
  if (!testedBy) throw httpError(400, "复测员不能为空");
  if (testedBy === order.releasedBy) {
    throw httpError(400, "出现回升后必须换人复测，复测员不能与释放员相同");
  }
  if (!Array.isArray(body.torques) || body.torques.length !== TOTAL_POINTS) {
    throw httpError(400, `复测必须提供 ${TOTAL_POINTS} 个时点扭矩（torques）`);
  }
  const torques = body.torques.map((value) => Number(value));
  if (torques.some((value) => !isFiniteNumber(value) || value < 0)) {
    throw httpError(400, "复测扭矩必须全部为非负数");
  }
  if (!rules.retestCurveOk(torques)) {
    throw httpError(400, "复测曲线后三次仍有回升，该次复测不能作为解除依据");
  }
  const measuredAt = body.measuredAt || new Date().toISOString();
  if (Number.isNaN(Date.parse(measuredAt))) throw httpError(400, "measuredAt 不是合法时间");
  return { testedBy, torques, measuredAt, note: typeof body.note === "string" ? body.note.trim() : "" };
}

// ---- 路由 ----

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;
  const db = await readDb();

  if (req.method === "GET" && pathname === "/health") {
    return send(res, 200, { ok: true, service: "clock-escapement-tuning-api", routes });
  }

  // ----- 原有：钟表与调校 -----

  if (req.method === "GET" && pathname === "/clocks") {
    const ctx = releaseContext(db);
    const qualified = url.searchParams.get("qualified");
    let data = db.clocks.map((clock) => clockSummary(db, clock, ctx));
    if (qualified !== null) data = data.filter((clock) => clock.qualified === (qualified === "true"));
    return send(res, 200, { data });
  }

  if (req.method === "POST" && pathname === "/clocks") {
    const body = await parseBody(req);
    required(body, ["code", "escapementType", "balanceFrequency"]);
    return withWrite(async () => {
      const live = await readDb();
      const clock = {
        id: makeId("clock"),
        code: body.code,
        escapementType: body.escapementType,
        balanceFrequency: body.balanceFrequency,
        targetDailyRateSeconds: Number(body.targetDailyRateSeconds ?? 30),
        note: body.note || "",
        createdAt: new Date().toISOString()
      };
      live.clocks.push(clock);
      await saveDb(live);
      return send(res, 201, { data: clockSummary(live, clock) });
    });
  }

  if (req.method === "GET" && pathname === "/clocks/not-qualified") {
    const ctx = releaseContext(db);
    const data = db.clocks.map((clock) => clockSummary(db, clock, ctx)).filter((clock) => !clock.qualified);
    return send(res, 200, { data });
  }

  const historyMatch = pathname.match(/^\/clocks\/([^/]+)\/history$/);
  if (historyMatch && req.method === "GET") {
    const clock = requireClock(db, historyMatch[1]);
    return send(res, 200, {
      data: {
        clock,
        adjustments: db.adjustments.filter((item) => item.clockId === clock.id),
        retests: db.retests.filter((item) => item.clockId === clock.id),
        latestRetest: latestRetest(db, clock.id)
      }
    });
  }

  const adjustmentMatch = pathname.match(/^\/clocks\/([^/]+)\/adjustments$/);
  if (adjustmentMatch && req.method === "POST") {
    requireClock(db, adjustmentMatch[1]);
    const body = await parseBody(req);
    required(body, ["currentDailyRateSeconds", "direction", "amount"]);
    return withWrite(async () => {
      const live = await readDb();
      const clock = requireClock(live, adjustmentMatch[1]);
      const adjustment = {
        id: makeId("adjustment"),
        clockId: clock.id,
        currentDailyRateSeconds: Number(body.currentDailyRateSeconds),
        direction: body.direction,
        amount: body.amount,
        note: body.note || "",
        createdAt: new Date().toISOString()
      };
      live.adjustments.push(adjustment);
      await saveDb(live);
      return send(res, 201, { data: adjustment });
    });
  }

  const retestMatch = pathname.match(/^\/clocks\/([^/]+)\/retests$/);
  if (retestMatch && req.method === "POST") {
    requireClock(db, retestMatch[1]);
    const body = await parseBody(req);
    required(body, ["dailyRateSeconds", "amplitude"]);
    return withWrite(async () => {
      const live = await readDb();
      const clock = requireClock(live, retestMatch[1]);
      const adjustmentId = body.adjustmentId || latestAdjustment(live, clock.id)?.id || null;
      const qualified = body.qualified !== undefined
        ? Boolean(body.qualified)
        : Math.abs(Number(body.dailyRateSeconds)) <= Number(clock.targetDailyRateSeconds);
      const retest = {
        id: makeId("retest"),
        clockId: clock.id,
        adjustmentId,
        testedAt: body.testedAt || new Date().toISOString(),
        dailyRateSeconds: Number(body.dailyRateSeconds),
        amplitude: Number(body.amplitude),
        qualified,
        note: body.note || ""
      };
      live.retests.push(retest);
      await saveDb(live);
      return send(res, 201, { data: retest, clock: clockSummary(live, clock) });
    });
  }

  const latestMatch = pathname.match(/^\/clocks\/([^/]+)\/latest-retest$/);
  if (latestMatch && req.method === "GET") {
    requireClock(db, latestMatch[1]);
    return send(res, 200, { data: latestRetest(db, latestMatch[1]) });
  }

  if (req.method === "GET" && pathname === "/adjustments") {
    const clockId = url.searchParams.get("clockId");
    return send(res, 200, { data: db.adjustments.filter((item) => !clockId || item.clockId === clockId) });
  }

  if (req.method === "GET" && pathname === "/retests") {
    const clockId = url.searchParams.get("clockId");
    const qualified = url.searchParams.get("qualified");
    const data = db.retests.filter((item) => {
      const matchClock = !clockId || item.clockId === clockId;
      const matchQualified = qualified === null || item.qualified === (qualified === "true");
      return matchClock && matchQualified;
    });
    return send(res, 200, { data });
  }

  // ----- 发条扭矩释放与拆机准入 -----

  // 登记释放单（幂等：已有未结束单时沿用首次结果；并发由写锁串行化）
  const releaseMatch = pathname.match(/^\/clocks\/([^/]+)\/release-orders$/);
  if (releaseMatch && req.method === "POST") {
    requireClock(db, releaseMatch[1]);
    const body = await parseBody(req);
    return withWrite(async () => {
      const live = await readDb();
      const clock = requireClock(live, releaseMatch[1]);
      const result = await registerRelease(live, clock, body, { revision: false });
      await saveDb(live);
      const view = orderView(live, result.order, result.ctx);
      return send(res, result.status, {
        data: view,
        reused: result.reused,
        admission: admissionFor(live, clock.id, result.ctx)
      });
    });
  }

  // 更换发条 / 更正释放值：旧版本只读失效，按新曲线重算
  const revisionMatch = pathname.match(/^\/clocks\/([^/]+)\/release-orders\/revisions$/);
  if (revisionMatch && req.method === "POST") {
    requireClock(db, revisionMatch[1]);
    const body = await parseBody(req);
    required(body, ["reason"]);
    if (!REVISION_REASONS[body.reason]) {
      throw httpError(400, `reason 必须是：${Object.keys(REVISION_REASONS).join(" / ")}`);
    }
    return withWrite(async () => {
      const live = await readDb();
      const clock = requireClock(live, revisionMatch[1]);
      const result = await registerRelease(live, clock, body, { revision: true, reason: body.reason });
      await saveDb(live);
      return send(res, 201, {
        data: orderView(live, result.order, result.ctx),
        superseded: orderView(live, result.supersededOrder, result.ctx),
        admission: admissionFor(live, clock.id, result.ctx)
      });
    });
  }

  // 单表履历：全部版本 + 六时点读数 + 复测 + 当前准入结论
  const releaseHistoryMatch = pathname.match(/^\/clocks\/([^/]+)\/release-history$/);
  if (releaseHistoryMatch && req.method === "GET") {
    const clock = requireClock(db, releaseHistoryMatch[1]);
    const ctx = releaseContext(db);
    const orders = db.releaseOrders
      .filter((item) => item.clockId === clock.id)
      .sort((a, b) => b.version - a.version)
      .map((order) => orderView(db, order, ctx));
    return send(res, 200, {
      data: {
        clock,
        admission: admissionFor(db, clock.id, ctx),
        orders
      }
    });
  }

  // 释放单列表：可按 clockId / state / admitted 过滤
  if (req.method === "GET" && pathname === "/release-orders") {
    const clockId = url.searchParams.get("clockId");
    const state = url.searchParams.get("state");
    const admitted = url.searchParams.get("admitted");
    const ctx = releaseContext(db);
    let data = db.releaseOrders
      .filter((item) => !clockId || item.clockId === clockId)
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      .map((order) => orderView(db, order, ctx));
    if (state !== null) data = data.filter((item) => item.evaluation.state === state);
    if (admitted !== null) data = data.filter((item) => item.evaluation.admitted === (admitted === "true"));
    return send(res, 200, { data });
  }

  // 记录释放后六个时点扭矩（可逐点或批量；已有点位只读）
  const readingsMatch = pathname.match(/^\/release-orders\/([^/]+)\/torque-readings$/);
  if (readingsMatch && req.method === "POST") {
    requireOrder(db, readingsMatch[1]);
    const body = await parseBody(req);
    const entries = parseReadingEntries(body);
    return withWrite(async () => {
      const live = await readDb();
      const order = requireOrder(live, readingsMatch[1]);
      const ctx = releaseContext(live);
      const current = evaluateOrder(
        order,
        ctx.readingsByOrder.get(order.id) || [],
        ctx.retestsByOrder.get(order.id) || []
      );
      if (current.readOnly) {
        throw httpError(409, "该释放单已结束或已被新版本取代，记录只读，不能再登记扭矩", {
          state: current.state
        });
      }

      const existing = new Map((ctx.readingsByOrder.get(order.id) || []).map((item) => [item.point, item]));
      const appended = [];
      let reused = 0;
      for (const entry of entries) {
        const old = existing.get(entry.point);
        if (old) {
          // 同一时点同值重复/并发提交：沿用首次结果；不同值则拒绝（旧记录只读）
          if (old.torque === entry.torque) {
            reused += 1;
            continue;
          }
          throw httpError(409, `时点 ${entry.point} 已记录扭矩 ${old.torque}，旧记录只读不能覆盖；如需更正请修订释放单`);
        }
        const record = {
          id: makeId("tr"),
          orderId: order.id,
          clockId: order.clockId,
          point: entry.point,
          torque: entry.torque,
          measuredAt: entry.measuredAt,
          recordedBy: entry.recordedBy || body.recordedBy || order.releasedBy,
          createdAt: new Date().toISOString()
        };
        live.torqueReadings.push(record);
        appended.push(record);
      }

      const nextCtx = releaseContext(live);
      const result = syncOrderStatus(live, order, nextCtx);
      await saveDb(live);
      return send(res, 201, {
        data: orderView(live, order, nextCtx),
        appended: appended.length,
        reused,
        admission: admissionFor(live, order.clockId, nextCtx),
        evaluation: result
      });
    });
  }

  // 回升后的换人复测：两次、间隔四小时，复测本身后三次也不得回升
  const orderRetestMatch = pathname.match(/^\/release-orders\/([^/]+)\/retests$/);
  if (orderRetestMatch && req.method === "POST") {
    requireOrder(db, orderRetestMatch[1]);
    const body = await parseBody(req);
    return withWrite(async () => {
      const live = await readDb();
      const order = requireOrder(live, orderRetestMatch[1]);
      const input = parseRetest(body, order);
      const ctx = releaseContext(live);

      // 重复/并发提交沿用首次结果（同人同时间同曲线）。
      // 查重优先于状态门：首条复测已解除准入后，重放同一请求仍返回首次结果。
      const duplicate = (ctx.retestsByOrder.get(order.id) || []).find(
        (item) =>
          item.testedBy === input.testedBy &&
          item.measuredAt === input.measuredAt &&
          JSON.stringify(item.torques) === JSON.stringify(input.torques)
      );
      if (duplicate) {
        return send(res, 200, { data: orderView(live, order, ctx), reused: true, retest: duplicate });
      }

      const current = evaluateOrder(
        order,
        ctx.readingsByOrder.get(order.id) || [],
        ctx.retestsByOrder.get(order.id) || []
      );
      if (current.state !== "rebound_held") {
        throw httpError(409, "仅在六时点记录后三次出现回升、等待复测时才能登记复测", {
          state: current.state
        });
      }

      const retest = {
        id: makeId("rr"),
        orderId: order.id,
        clockId: order.clockId,
        testedBy: input.testedBy,
        torques: input.torques,
        measuredAt: input.measuredAt,
        note: input.note,
        createdAt: new Date().toISOString()
      };
      live.releaseRetests.push(retest);

      const nextCtx = releaseContext(live);
      const result = syncOrderStatus(live, order, nextCtx);
      await saveDb(live);
      return send(res, 201, {
        data: orderView(live, order, nextCtx),
        retest,
        reused: false,
        admission: admissionFor(live, order.clockId, nextCtx),
        evaluation: result
      });
    });
  }

  const orderMatch = pathname.match(/^\/release-orders\/([^/]+)$/);
  if (orderMatch && req.method === "GET") {
    const order = requireOrder(db, orderMatch[1]);
    return send(res, 200, { data: orderView(db, order), admission: admissionFor(db, order.clockId) });
  }

  return send(res, 404, { error: "接口不存在", routes });
}

module.exports = { handle, routes };
