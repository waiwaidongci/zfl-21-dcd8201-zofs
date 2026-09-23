// 请求入口层：发条扭矩释放与拆机准入台的 HTTP 路由。
// 只负责解析请求、调用判定规则（releaseRules）和落库（releaseStore），
// 不在此编写业务判定；写操作全部按钟表维度串行，重复/并发提交沿用首次结果。
const { readDb, writeDb, makeId, withClockLock } = require("./releaseStore");
const rules = require("./releaseRules");

const releaseRoutes = [
  "POST /clocks/:id/releases",
  "POST /clocks/:id/releases/spring",
  "POST /clocks/:id/releases/correct",
  "POST /clocks/:id/releases/readings",
  "POST /clocks/:id/releases/retests",
  "GET  /clocks/:id/releases",
  "GET  /clocks/:id/releases/history",
  "GET  /clocks/:id/releases/:orderId",
  "GET  /releases?clockId="
];

function send(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body, null, 2));
}

function fail(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

async function parseBody(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw fail(400, "请求体必须是合法JSON");
  }
}

function parseTestedAt(value) {
  if (value === undefined || value === null || value === "") return new Date().toISOString();
  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) throw fail(400, "testedAt 必须是合法时间");
  return new Date(time).toISOString();
}

function findClock(db, clockId) {
  const clock = db.clocks.find((item) => item.id === clockId);
  if (!clock) throw fail(404, "钟表不存在");
  return clock;
}

// 在库中重建某张单的只读视图。
function viewOf(db, orderId, extra) {
  const order = db.releaseOrders.find((item) => item.id === orderId);
  if (!order) throw fail(404, "释放单不存在");
  return rules.buildOrderView(db, order, extra || {});
}

// 登记新释放单时附带的六时点曲线：残余超标单只落释放单、拒收曲线，
// 其余情况做完整校验后随单入库。
function attachCurveOnCreate(db, order, body) {
  if (body.torques === undefined && body.readings === undefined) {
    return { curve: null, curveRejected: false };
  }
  if (rules.isResidualOverLimit(order)) {
    return { curve: null, curveRejected: true };
  }
  const checked = rules.validateTorques(body);
  if (!checked.ok) throw fail(checked.status, checked.message);
  const curve = {
    id: makeId("curve"),
    clockId: order.clockId,
    orderId: order.id,
    torques: checked.value,
    testedAt: parseTestedAt(body.testedAt)
  };
  db.releaseCurves.push(curve);
  return { curve, curveRejected: false };
}

function buildOrderRecord({ clockId, reason, revisionOfId, input, body }) {
  return {
    id: makeId("release"),
    clockId,
    revisionOfId,
    reason,
    fullWindTorque: input.fullWindTorque,
    residualTorque: input.residualTorque,
    restingMinutes: input.restingMinutes,
    operator: input.operator,
    note: typeof body.note === "string" ? body.note : "",
    createdAt: new Date().toISOString()
  };
}

// 登记新释放单：存在未结束释放单时，重复或并发提交直接沿用首次结果。
async function createRelease(req, res, clockId, mode) {
  const body = await parseBody(req);

  await withClockLock(clockId, async () => {
    const db = await readDb();
    findClock(db, clockId);

    const found = rules.findActiveOrder(db, clockId);
    const current = found ? found.active : null;

    // 更正/换发条是显式失效动作，任何状态下都开新修订；
    // 普通登记只要已存在释放单（无论是否结束）都幂等返回首次结果，
    // 新一轮释放必须显式走 /spring 或 /correct。
    if (mode === "initial" && current) {
      return send(res, 200, {
        data: viewOf(db, current.id),
        reused: true,
        message: "该表已登记过释放单，沿用首次结果；如需重算请走更换发条或更正接口"
      });
    }

    let recordInput;
    let revisionOfId = null;

    if (mode === "correct") {
      if (!current) throw fail(400, "该表尚无释放单，无法更正，请先登记");
      const hasAny = ["fullWindTorque", "residualTorque", "restingMinutes", "operator"]
        .some((field) => body[field] !== undefined && body[field] !== null && body[field] !== "");
      if (!hasAny) throw fail(400, "更正至少需要提供满弦扭矩、残余扭矩、静置分钟或释放员中的一项");
      const merged = {
        fullWindTorque: body.fullWindTorque !== undefined ? body.fullWindTorque : current.fullWindTorque,
        residualTorque: body.residualTorque !== undefined ? body.residualTorque : current.residualTorque,
        restingMinutes: body.restingMinutes !== undefined ? body.restingMinutes : current.restingMinutes,
        operator: body.operator !== undefined ? body.operator : current.operator
      };
      const checked = rules.validateReleaseInput(merged);
      if (!checked.ok) throw fail(checked.status, checked.message);
      recordInput = checked.value;
      revisionOfId = current.id;
    } else {
      const checked = rules.validateReleaseInput(body);
      if (!checked.ok) throw fail(checked.status, checked.message);
      recordInput = checked.value;
      if (mode === "spring") {
        if (!current) throw fail(400, "该表尚无释放单，更换发条前请先登记原释放单");
        revisionOfId = current.id;
      }
      // initial 且上一张已结束：开启全新一轮释放链，旧结论保留不改写。
    }

    const order = buildOrderRecord({
      clockId,
      reason: mode === "spring" ? "spring_replace" : mode === "correct" ? "correct" : "initial",
      revisionOfId,
      input: recordInput,
      body
    });
    db.releaseOrders.push(order);
    const attached = attachCurveOnCreate(db, order, body);
    await writeDb(db);

    return send(res, 201, {
      data: viewOf(db, order.id),
      reused: false,
      curveRejected: attached.curveRejected,
      supersededOrderId: revisionOfId,
      message: attached.curveRejected
        ? "残余扭矩高于满弦扭矩一成，已拒绝拆机；释放单已登记，扭矩曲线不予受理"
        : revisionOfId
          ? "原释放单已失效并只读保留，准入按新曲线重算"
          : undefined
    });
  });
}

// 登记六个时点的释放扭矩（可重复提交而不产生第二张曲线）。
async function addReadings(req, res, clockId) {
  const body = await parseBody(req);
  const checked = rules.validateTorques(body);
  if (!checked.ok) throw fail(checked.status, checked.message);
  const testedAt = parseTestedAt(body.testedAt);

  await withClockLock(clockId, async () => {
    const db = await readDb();
    findClock(db, clockId);
    const found = rules.findActiveOrder(db, clockId);
    if (!found) throw fail(400, "该表尚无释放单，请先登记");
    const order = found.active;
    const view = rules.buildOrderView(db, order);

    if (view.admission === "rejected") {
      throw fail(409, "残余扭矩高于满弦扭矩一成，已拒绝拆机，不再受理曲线");
    }
    const existing = db.releaseCurves.find((item) => item.orderId === order.id);
    if (existing) {
      return send(res, 200, { data: viewOf(db, order.id), reused: true, message: "六时点扭矩已登记，沿用首次记录" });
    }

    db.releaseCurves.push({
      id: makeId("curve"),
      clockId,
      orderId: order.id,
      torques: checked.value,
      testedAt
    });
    await writeDb(db);
    return send(res, 201, { data: viewOf(db, order.id), reused: false });
  });
}

// 回升后的换人复测：换人、六时点、间隔四小时，有效复测满两次解除封锁。
async function addRetest(req, res, clockId) {
  const body = await parseBody(req);
  if (body.operator === undefined || body.operator === null || body.operator === "") {
    throw fail(400, "缺少字段：operator");
  }
  const torquesChecked = rules.validateTorques(body);
  if (!torquesChecked.ok) throw fail(torquesChecked.status, torquesChecked.message);
  const testedAt = parseTestedAt(body.testedAt);

  await withClockLock(clockId, async () => {
    const db = await readDb();
    findClock(db, clockId);
    const found = rules.findActiveOrder(db, clockId);
    if (!found) throw fail(400, "该表尚无释放单，请先登记");
    const order = found.active;
    const curve = db.releaseCurves.find((item) => item.orderId === order.id);
    const view = rules.buildOrderView(db, order);

    if (view.admission === "rejected") throw fail(409, "释放单已因残余扭矩超标拒绝拆机，无需复测");
    if (!curve) throw fail(409, "尚未登记六个时点扭矩，暂不能复测");
    if (!view.evaluation.curveAnalysis.hasRebound) {
      throw fail(409, "释放曲线后三次未回升，未封锁拆机，无需复测");
    }
    if (String(body.operator).trim() === String(order.operator).trim()) {
      throw fail(400, "复测员与释放员为同一人，出现回升必须换人复测");
    }

    // 预演本次复测是否合格：换人已保证，检查自身曲线与四小时间隔。
    const draft = {
      id: "draft",
      orderId: order.id,
      operator: String(body.operator).trim(),
      torques: torquesChecked.value,
      testedAt
    };
    const draftAnalysis = rules.analyzeRetest(order, draft);
    if (draftAnalysis.hasRebound) {
      // 测量本身留档（只读），但不计入有效复测。
      draft.note = typeof body.note === "string" ? body.note : "";
      draft.id = makeId("retest");
      db.releaseRetests.push(draft);
      await writeDb(db);
      return send(res, 201, {
        data: viewOf(db, order.id),
        accepted: false,
        message: "复测曲线后三次仍有回升，本次复测留档但不计入有效次数"
      });
    }

    const acceptedSoFar = db.releaseRetests
      .filter((item) => item.orderId === order.id)
      .sort((a, b) => new Date(a.testedAt) - new Date(b.testedAt))
      .filter((item) => {
        const analysis = rules.analyzeRetest(order, item);
        return analysis.eligible;
      });
    const prev = acceptedSoFar[acceptedSoFar.length - 1] || null;
    const interval = rules.meetsInterval(prev, draft);
    if (!interval.ok) throw fail(409, interval.message);

    db.releaseRetests.push({
      id: makeId("retest"),
      clockId,
      orderId: order.id,
      operator: String(body.operator).trim(),
      torques: torquesChecked.value,
      testedAt,
      note: typeof body.note === "string" ? body.note : ""
    });
    await writeDb(db);
    return send(res, 201, { data: viewOf(db, order.id), accepted: true });
  });
}

async function getReleaseStatus(req, res, clockId) {
  const db = await readDb();
  findClock(db, clockId);
  return send(res, 200, { data: rules.clockReleaseSummary(db, clockId) });
}

async function getReleaseHistory(req, res, clockId) {
  const db = await readDb();
  findClock(db, clockId);
  const found = rules.findActiveOrder(db, clockId);
  const activeId = found ? found.active.id : null;
  const supersededIds = found ? found.supersededIds : new Set();
  const orders = db.releaseOrders
    .filter((item) => item.clockId === clockId)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .map((order) => rules.buildOrderView(db, order, {
      invalidated: supersededIds.has(order.id)
    }));
  return send(res, 200, {
    data: {
      clockId,
      activeOrderId: activeId,
      summary: rules.clockReleaseSummary(db, clockId),
      orders
    }
  });
}

async function getOrder(req, res, clockId, orderId) {
  const db = await readDb();
  findClock(db, clockId);
  const order = db.releaseOrders.find((item) => item.id === orderId && item.clockId === clockId);
  if (!order) throw fail(404, "释放单不存在");
  const found = rules.findActiveOrder(db, clockId);
  const invalidated = found ? found.supersededIds.has(order.id) : false;
  return send(res, 200, { data: rules.buildOrderView(db, order, { invalidated }) });
}

async function listReleases(req, res, url) {
  const db = await readDb();
  const clockId = url.searchParams.get("clockId");
  const admission = url.searchParams.get("admission");
  let orders = db.releaseOrders.filter((item) => !clockId || item.clockId === clockId);

  // 失效标记按表计算。
  const clockIds = [...new Set(orders.map((item) => item.clockId))];
  const supersededByClock = new Map();
  for (const id of clockIds) supersededByClock.set(id, rules.findActiveOrder(db, id)?.supersededIds || new Set());

  let data = orders
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .map((order) => rules.buildOrderView(db, order, {
      invalidated: (supersededByClock.get(order.clockId) || new Set()).has(order.id)
    }));
  if (admission !== null) data = data.filter((item) => item.admission === admission);
  return send(res, 200, { data });
}

// 返回 true 表示请求已由本模块处理。
async function handleRelease(req, res, url) {
  const pathname = url.pathname;

  if (req.method === "GET" && pathname === "/releases") {
    await listReleases(req, res, url);
    return true;
  }

  const createMatch = pathname.match(/^\/clocks\/([^/]+)\/releases$/);
  if (createMatch) {
    if (req.method === "POST") {
      await createRelease(req, res, createMatch[1], "initial");
    } else if (req.method === "GET") {
      await getReleaseStatus(req, res, createMatch[1]);
    } else {
      throw fail(405, "方法不允许");
    }
    return true;
  }

  const subMatch = pathname.match(/^\/clocks\/([^/]+)\/releases\/([^/]+)$/);
  if (subMatch && req.method === "GET") {
    const [, clockId, sub] = subMatch;
    if (sub === "history") {
      await getReleaseHistory(req, res, clockId);
    } else {
      await getOrder(req, res, clockId, sub);
    }
    return true;
  }

  const actionMatch = pathname.match(/^\/clocks\/([^/]+)\/releases\/(spring|correct|readings|retests)$/);
  if (actionMatch && req.method === "POST") {
    const [, clockId, action] = actionMatch;
    if (action === "spring") await createRelease(req, res, clockId, "spring");
    else if (action === "correct") await createRelease(req, res, clockId, "correct");
    else if (action === "readings") await addReadings(req, res, clockId);
    else await addRetest(req, res, clockId);
    return true;
  }
  if (actionMatch) throw fail(405, "方法不允许");

  return false;
}

module.exports = { releaseRoutes, handleRelease };
