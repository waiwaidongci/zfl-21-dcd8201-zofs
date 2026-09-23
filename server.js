const http = require("http");
const { readDb, writeDb, makeId } = require("./src/releaseStore");
const { releaseRoutes, handleRelease } = require("./src/releaseRoutes");
const rules = require("./src/releaseRules");

const PORT = Number(process.env.PORT || 3021);

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
  ...releaseRoutes
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
    const error = new Error("请求体必须是合法JSON");
    error.status = 400;
    throw error;
  }
}

function required(body, fields) {
  const missing = fields.filter((field) => body[field] === undefined || body[field] === "");
  if (missing.length) {
    const error = new Error(`缺少字段：${missing.join(", ")}`);
    error.status = 400;
    throw error;
  }
}

function findClock(db, clockId) {
  const clock = db.clocks.find((item) => item.id === clockId);
  if (!clock) {
    const error = new Error("钟表不存在");
    error.status = 404;
    throw error;
  }
  return clock;
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

// 走时调校结论与发条拆机准入结论都从原始记录现算，保证刷新后一致。
function clockSummary(db, clock) {
  const retest = latestRetest(db, clock.id);
  const adjustment = latestAdjustment(db, clock.id);
  return {
    ...clock,
    latestAdjustment: adjustment,
    latestRetest: retest,
    qualified: retest ? retest.qualified : false,
    release: rules.clockReleaseSummary(db, clock.id)
  };
}

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;
  const db = await readDb();

  if (req.method === "GET" && pathname === "/health") {
    return send(res, 200, { ok: true, service: "clock-escapement-tuning-api", routes });
  }

  // 发条扭矩释放与拆机准入台（请求入口集中在 src/releaseRoutes.js）。
  if (pathname === "/releases" || pathname.includes("/releases")) {
    const handled = await handleRelease(req, res, url);
    if (handled) return;
  }

  if (req.method === "GET" && pathname === "/clocks") {
    const qualified = url.searchParams.get("qualified");
    let data = db.clocks.map((clock) => clockSummary(db, clock));
    if (qualified !== null) {
      const expected = qualified === "true";
      data = data.filter((clock) => clock.qualified === expected);
    }
    return send(res, 200, { data });
  }

  if (req.method === "POST" && pathname === "/clocks") {
    const body = await parseBody(req);
    required(body, ["code", "escapementType", "balanceFrequency"]);
    const clock = {
      id: makeId("clock"),
      code: body.code,
      escapementType: body.escapementType,
      balanceFrequency: body.balanceFrequency,
      targetDailyRateSeconds: Number(body.targetDailyRateSeconds ?? 30),
      note: body.note || "",
      createdAt: new Date().toISOString()
    };
    db.clocks.push(clock);
    await writeDb(db);
    return send(res, 201, { data: clockSummary(db, clock) });
  }

  if (req.method === "GET" && pathname === "/clocks/not-qualified") {
    const data = db.clocks.map((clock) => clockSummary(db, clock)).filter((clock) => !clock.qualified);
    return send(res, 200, { data });
  }

  const historyMatch = pathname.match(/^\/clocks\/([^/]+)\/history$/);
  if (historyMatch && req.method === "GET") {
    const clock = findClock(db, historyMatch[1]);
    const adjustments = db.adjustments.filter((item) => item.clockId === clock.id);
    const retests = db.retests.filter((item) => item.clockId === clock.id);
    return send(res, 200, {
      data: {
        clock,
        adjustments,
        retests,
        latestRetest: latestRetest(db, clock.id),
        release: rules.clockReleaseSummary(db, clock.id)
      }
    });
  }

  const adjustmentMatch = pathname.match(/^\/clocks\/([^/]+)\/adjustments$/);
  if (adjustmentMatch && req.method === "POST") {
    const clock = findClock(db, adjustmentMatch[1]);
    const body = await parseBody(req);
    required(body, ["currentDailyRateSeconds", "direction", "amount"]);
    const adjustment = {
      id: makeId("adjustment"),
      clockId: clock.id,
      currentDailyRateSeconds: Number(body.currentDailyRateSeconds),
      direction: body.direction,
      amount: body.amount,
      note: body.note || "",
      createdAt: new Date().toISOString()
    };
    db.adjustments.push(adjustment);
    await writeDb(db);
    return send(res, 201, { data: adjustment });
  }

  const retestMatch = pathname.match(/^\/clocks\/([^/]+)\/retests$/);
  if (retestMatch && req.method === "POST") {
    const clock = findClock(db, retestMatch[1]);
    const body = await parseBody(req);
    required(body, ["dailyRateSeconds", "amplitude"]);
    const adjustmentId = body.adjustmentId || latestAdjustment(db, clock.id)?.id || null;
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
    db.retests.push(retest);
    await writeDb(db);
    return send(res, 201, { data: retest, clock: clockSummary(db, clock) });
  }

  const latestMatch = pathname.match(/^\/clocks\/([^/]+)\/latest-retest$/);
  if (latestMatch && req.method === "GET") {
    findClock(db, latestMatch[1]);
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

  return send(res, 404, { error: "接口不存在", routes });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((error) => send(res, error.status || 500, { error: error.message || "服务器错误" }));
});

server.listen(PORT, () => {
  console.log(`Clock escapement tuning API running at http://127.0.0.1:${PORT}`);
});
