// 判定规则层：发条释放与拆机准入的全部业务规则。
// 本文件只做纯计算，不读写文件、不发响应，因此列表、单表履历、
// 刷新结论三处复用同一套推导，结果必然一致。

const POINT_COUNT = 6; // 六个时点
const RETEST_REQUIRED_COUNT = 2; // 回升后须换人复测两次
const RETEST_INTERVAL_MS = 4 * 60 * 60 * 1000; // 两次复测间隔至少四小时
const RESIDUAL_RATIO_LIMIT = 0.1; // 残余扭矩不得高于满弦扭矩一成
const VALID_REASONS = ["initial", "spring_replace", "correct"];

function toFiniteNumber(value) {
  if (value === undefined || value === null || value === "") return null;
  const num = typeof value === "number" ? value : Number(value);
  return Number.isFinite(num) ? num : null;
}

// 登记项校验：满弦扭矩、释放后残余扭矩、静置分钟、释放员缺一不可。
function validateReleaseInput(body) {
  const missing = [];
  for (const field of ["fullWindTorque", "residualTorque", "restingMinutes", "operator"]) {
    if (body[field] === undefined || body[field] === null || body[field] === "") missing.push(field);
  }
  if (missing.length) {
    return { ok: false, status: 400, message: `缺少字段：${missing.join("、")}` };
  }

  const fullWindTorque = toFiniteNumber(body.fullWindTorque);
  const residualTorque = toFiniteNumber(body.residualTorque);
  const restingMinutes = toFiniteNumber(body.restingMinutes);

  if (fullWindTorque === null || fullWindTorque <= 0) {
    return { ok: false, status: 400, message: "满弦扭矩必须是大于0的数值" };
  }
  if (residualTorque === null || residualTorque < 0) {
    return { ok: false, status: 400, message: "释放后残余扭矩必须是非负数值" };
  }
  if (restingMinutes === null || restingMinutes < 0) {
    return { ok: false, status: 400, message: "静置分钟必须是非负数值" };
  }
  if (!String(body.operator).trim()) {
    return { ok: false, status: 400, message: "释放员不能为空" };
  }
  return {
    ok: true,
    value: {
      fullWindTorque,
      residualTorque,
      restingMinutes,
      operator: String(body.operator).trim()
    }
  };
}

// 六个时点扭矩序列校验：必须恰好六个大于0的数值。
function validateTorques(body) {
  const torquesRaw = body.torques ?? body.readings;
  if (!Array.isArray(torquesRaw)) {
    return { ok: false, status: 400, message: "缺少字段：torques（六个时点扭矩数组）" };
  }
  if (torquesRaw.length !== POINT_COUNT) {
    return { ok: false, status: 400, message: `必须提交${POINT_COUNT}个时点的扭矩，当前${torquesRaw.length}个` };
  }
  const torques = torquesRaw.map(toFiniteNumber);
  if (torques.some((value) => value === null || value <= 0)) {
    return { ok: false, status: 400, message: "六个时点的扭矩都必须是大于0的数值" };
  }
  return { ok: true, value: torques };
}

// 残余扭矩高于满弦扭矩一成 => 拒绝拆机（硬性拒绝，曲线与复测无法翻案）。
function isResidualOverLimit(order) {
  return order.residualTorque > order.fullWindTorque * RESIDUAL_RATIO_LIMIT + Number.EPSILON;
}

// 后三次（第4、5、6时点）不得回升；返回首次回升的时点对。
function analyzeCurve(torques) {
  const rebounds = [];
  for (let i = 3; i < torques.length; i++) {
    if (torques[i] > torques[i - 1] + Number.EPSILON) {
      rebounds.push({ fromPoint: i, toPoint: i + 1, from: torques[i - 1], to: torques[i] });
    }
  }
  return {
    pointCount: torques.length,
    lastThree: torques.slice(3),
    rebounds,
    hasRebound: rebounds.length > 0
  };
}

// 复测人员必须与释放员不同。
function isOperatorDifferent(order, retest) {
  return String(retest.operator || "").trim() !== String(order.operator).trim();
}

// 复测是否有效：换人 + 自身曲线后三次不回升。
function analyzeRetest(order, retest) {
  const curve = analyzeCurve(retest.torques);
  const sameOperator = !isOperatorDifferent(order, retest);
  const eligible = !sameOperator && !curve.hasRebound;
  const reasons = [];
  if (sameOperator) reasons.push("复测员与释放员为同一人，必须换人");
  if (curve.hasRebound) reasons.push("复测曲线后三次仍有回升");
  return { ...curve, sameOperator, eligible, reasons };
}

// 判定某次复测是否满足与上一条有效复测间隔四小时的要求。
function meetsInterval(prevRetest, retest) {
  if (!prevRetest) return { ok: true };
  const gap = new Date(retest.testedAt).getTime() - new Date(prevRetest.testedAt).getTime();
  if (gap < RETEST_INTERVAL_MS) {
    return {
      ok: false,
      message: `两次复测间隔不足${RETEST_INTERVAL_MS / 3_600_000}小时（当前${(gap / 3_600_000).toFixed(1)}小时），暂不能解除封锁`
    };
  }
  return { ok: true, gapMs: gap };
}

// 复测综合结论：仅“换人、曲线不回升、间隔四小时”的复测计入有效次数。
function evaluateRetests(order, curve, retests) {
  const ordered = [...retests].sort(
    (a, b) => new Date(a.testedAt).getTime() - new Date(b.testedAt).getTime()
  );

  const attempts = [];
  const accepted = [];
  for (const retest of ordered) {
    const analysis = analyzeRetest(order, retest);
    const prev = accepted[accepted.length - 1] || null;
    const interval = meetsInterval(prev, retest);

    let acceptedFlag = false;
    const blockers = [...analysis.reasons];
    if (analysis.eligible && !interval.ok) {
      blockers.push(interval.message);
    } else if (analysis.eligible) {
      acceptedFlag = true;
      accepted.push(retest);
    }
    attempts.push({
      retestId: retest.id,
      testedAt: retest.testedAt,
      operator: retest.operator,
      torques: retest.torques,
      note: retest.note || "",
      rebounds: analysis.rebounds,
      accepted: acceptedFlag,
      blockers
    });
  }

  return {
    attempts,
    acceptedCount: accepted.length,
    requiredCount: RETEST_REQUIRED_COUNT,
    // 第二次有效复测完成即解除。
    cleared: accepted.length >= RETEST_REQUIRED_COUNT,
    nextIntervalAfter: accepted.length && accepted.length < RETEST_REQUIRED_COUNT
      ? accepted[accepted.length - 1].testedAt
      : null
  };
}

// 单张释放单的准入推导。所有状态皆由原始记录现算，不依赖冗余状态字段。
function evaluateOrder(order, curve, retests) {
  const retestList = retests || [];

  // 1) 登记阶段残余过高：拒绝拆机，曲线/复测均不可翻案。
  if (isResidualOverLimit(order)) {
    return {
      orderId: order.id,
      reason: order.reason,
      registered: true,
      curveRecorded: Boolean(curve),
      admission: "rejected",
      ended: true,
      residualRatio: order.residualTorque / order.fullWindTorque,
      reasons: ["残余扭矩高于满弦扭矩一成，拒绝拆机"]
    };
  }

  // 2) 尚未提交六时点曲线：流程进行中。
  if (!curve) {
    return {
      orderId: order.id,
      reason: order.reason,
      registered: true,
      curveRecorded: false,
      admission: "pending_curve",
      ended: false,
      reasons: ["已登记，等待提交六个时点的释放扭矩"]
    };
  }

  const curveAnalysis = analyzeCurve(curve.torques);

  // 3) 曲线后三次没有回升：允许拆机，流程结束。
  if (!curveAnalysis.hasRebound) {
    return {
      orderId: order.id,
      reason: order.reason,
      registered: true,
      curveRecorded: true,
      testedAt: curve.testedAt,
      torques: curve.torques,
      curveAnalysis,
      admission: "admitted",
      ended: true,
      reasons: ["残余扭矩达标且后三次扭矩未回升，允许拆机"]
    };
  }

  // 4) 出现回升：封锁拆机，换人复测两次、间隔四小时后才解除。
  const retestResult = evaluateRetests(order, curveAnalysis, retestList);
  if (retestResult.cleared) {
    return {
      orderId: order.id,
      reason: order.reason,
      registered: true,
      curveRecorded: true,
      testedAt: curve.testedAt,
      torques: curve.torques,
      curveAnalysis,
      retests: retestResult,
      admission: "admitted",
      ended: true,
      reasons: ["初次曲线后三次回升，已由他人复测两次且间隔四小时、曲线均不回升，解除封锁，允许拆机"]
    };
  }

  return {
    orderId: order.id,
    reason: order.reason,
    registered: true,
    curveRecorded: true,
    testedAt: curve.testedAt,
    torques: curve.torques,
    curveAnalysis,
    retests: retestResult,
    admission: "blocked",
    ended: false,
    reasons: [
      "释放曲线后三次扭矩出现回升，拆机封锁中",
      `须由非释放员复测${RETEST_REQUIRED_COUNT}次、两次间隔至少四小时且复测曲线后三次不回升（已有效复测${retestResult.acceptedCount}次）`
    ]
  };
}

// 沿 revisionOfId 链找到当前生效释放单（最新修订）。
// 旧单始终只读保留，新单出现即代表旧单准入失效。
function findActiveOrder(db, clockId) {
  const orders = db.releaseOrders
    .filter((order) => order.clockId === clockId)
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
  if (!orders.length) return null;
  const byId = new Map(orders.map((order) => [order.id, order]));
  const active = orders[orders.length - 1];

  // 校验链是否连续归属本表；被新单引用的旧单标记为已失效。
  const supersededIds = new Set();
  let cursor = active;
  const guard = new Set();
  while (cursor && cursor.revisionOfId) {
    if (guard.has(cursor.id)) break;
    guard.add(cursor.id);
    supersededIds.add(cursor.revisionOfId);
    cursor = byId.get(cursor.revisionOfId) || null;
  }
  return { active, supersededIds };
}

function buildOrderView(db, order, options = {}) {
  const curve = (db.releaseCurves || []).find((item) => item.orderId === order.id) || null;
  const retests = (db.releaseRetests || []).filter((item) => item.orderId === order.id);
  const evaluation = evaluateOrder(order, curve, retests);
  return {
    order,
    curve,
    retests: [...retests].sort(
      (a, b) => new Date(a.testedAt).getTime() - new Date(b.testedAt).getTime()
    ),
    admission: evaluation.admission,
    ended: evaluation.ended,
    // 旧单只读：一旦被后续修订引用，其准入结论即失效。
    invalidated: options.invalidated === true,
    evaluation
  };
}

// 单表发条准入汇总：列表 / 履历 / 单查刷新都走这里。
function clockReleaseSummary(db, clockId) {
  const found = findActiveOrder(db, clockId);
  if (!found) {
    return {
      clockId,
      hasRelease: false,
      activeOrderId: null,
      admission: "none",
      ended: false,
      active: null
    };
  }
  const { active, supersededIds } = found;
  const activeView = buildOrderView(db, active, { invalidated: false });
  return {
    clockId,
    hasRelease: true,
    activeOrderId: active.id,
    reason: active.reason,
    admission: activeView.admission,
    ended: activeView.ended,
    active: activeView
  };
}

module.exports = {
  POINT_COUNT,
  RETEST_REQUIRED_COUNT,
  RETEST_INTERVAL_MS,
  RESIDUAL_RATIO_LIMIT,
  VALID_REASONS,
  toFiniteNumber,
  validateReleaseInput,
  validateTorques,
  isResidualOverLimit,
  analyzeCurve,
  isOperatorDifferent,
  analyzeRetest,
  meetsInterval,
  evaluateRetests,
  evaluateOrder,
  findActiveOrder,
  buildOrderView,
  clockReleaseSummary
};
