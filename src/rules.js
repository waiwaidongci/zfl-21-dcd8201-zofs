"use strict";

// 判定规则（纯函数）：登记校验、一成残余、六点曲线后三次不回升、
// 换人复测两次且间隔四小时、版本失效重算。
// 所有结论一律由记录实时派生，不做长期缓存，保证列表、单表履历、
// 刷新后结论一致。

// 残余扭矩超过满弦扭矩的一成（严格大于 10%）才拒绝；恰为一成放行
const RESIDUAL_RATIO_LIMIT = 0.1;
const TOTAL_POINTS = 6;
const CHECKED_POINTS = 3; // 后三次（第 4/5/6 时点）
const REQUIRED_RETESTS = 2;
const RETEST_INTERVAL_MINUTES = 4 * 60;

const REVISION_REASONS = {
  mainspring_replacement: "更换发条",
  release_value_correction: "更正释放值"
};

function httpError(status, message, extra = {}) {
  return Object.assign(new Error(message), { status }, extra);
}

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function positiveNumber(value) {
  return isFiniteNumber(value) && value > 0;
}

// 登记缺项校验：四项缺一不可，扭矩必须为正数
function validateRegistration(body) {
  const fields = {
    fullWindTorque: "满弦扭矩",
    residualTorque: "释放后残余扭矩",
    restingMinutes: "静置分钟",
    releasedBy: "释放员"
  };
  for (const [field, label] of Object.entries(fields)) {
    if (body[field] === undefined || body[field] === null || body[field] === "") {
      throw httpError(400, `缺少字段：${label}（${field}）`);
    }
  }
  const fullWindTorque = Number(body.fullWindTorque);
  const residualTorque = Number(body.residualTorque);
  const restingMinutes = Number(body.restingMinutes);
  if (!positiveNumber(fullWindTorque)) throw httpError(400, "满弦扭矩必须为正数");
  if (!isFiniteNumber(residualTorque) || residualTorque < 0) {
    throw httpError(400, "释放后残余扭矩必须为非负数");
  }
  if (!positiveNumber(restingMinutes)) throw httpError(400, "静置分钟必须为正数");
  if (typeof body.releasedBy !== "string" || !body.releasedBy.trim()) {
    throw httpError(400, "释放员不能为空");
  }
  return {
    fullWindTorque,
    residualTorque,
    restingMinutes,
    releasedBy: body.releasedBy.trim(),
    note: typeof body.note === "string" ? body.note.trim() : ""
  };
}

// 残余扭矩高于满弦扭矩一成 → 拒绝拆机
function residualExceedsLimit(fullWindTorque, residualTorque) {
  return residualTorque > fullWindTorque * RESIDUAL_RATIO_LIMIT;
}

function sortedTorques(readings) {
  return [...readings].sort((a, b) => a.point - b.point).map((item) => item.torque);
}

// 后三次不得回升：第 4/5/6 时点必须非递增。
// 返回 { complete, rebound, rebounds }
function evaluateCurve(readings) {
  const byPoint = new Map();
  for (const item of readings) byPoint.set(item.point, item.torque);
  const present = [...byPoint.keys()].sort((a, b) => a - b);
  const complete = present.length === TOTAL_POINTS && present.every((p, i) => p === i + 1);

  const rebounds = [];
  if ([4, 5, 6].every((p) => byPoint.has(p))) {
    const t4 = byPoint.get(4);
    const t5 = byPoint.get(5);
    const t6 = byPoint.get(6);
    if (t5 > t4) rebounds.push({ fromPoint: 4, toPoint: 5, fromTorque: t4, toTorque: t5 });
    if (t6 > t5) rebounds.push({ fromPoint: 5, toPoint: 6, fromTorque: t5, toTorque: t6 });
  }
  return { complete, torques: sortedTorques(readings), rebound: rebounds.length > 0, rebounds };
}

function minutesBetween(aIso, bIso) {
  return Math.abs(new Date(bIso) - new Date(aIso)) / 60000;
}

// 复测曲线本身也必须满足后三次不回升
function retestCurveOk(torques) {
  if (torques.length !== TOTAL_POINTS) return false;
  return torques[5] <= torques[4] && torques[4] <= torques[3];
}

// 换人复测两次、间隔四小时的解除条件。
// 以按测量时间排序后的最后两条为准（更早的失败尝试只留在历史里）。
function evaluateRetests(order, retests, readings) {
  const missing = [];
  if (retests.length < REQUIRED_RETESTS) {
    missing.push(`还需 ${REQUIRED_RETESTS - retests.length} 次换人复测`);
  }

  const validCurveRetests = retests.filter((r) => retestCurveOk(r.torques));
  const latestTwo = validCurveRetests.slice(-REQUIRED_RETESTS);

  let differentOperator = false;
  let intervalMinutes = null;
  let intervalOk = false;

  if (latestTwo.length === REQUIRED_RETESTS) {
    const [first, second] = latestTwo;
    differentOperator = second.testedBy !== order.releasedBy && first.testedBy !== order.releasedBy;
    intervalMinutes = minutesBetween(first.measuredAt, second.measuredAt);
    intervalOk = intervalMinutes >= RETEST_INTERVAL_MINUTES;

    if (!differentOperator) missing.push("复测员必须与释放员不同（换人）");
    if (!intervalOk) {
      missing.push(
        `两次复测间隔不足 ${RETEST_INTERVAL_MINUTES} 分钟（当前 ${Math.round(intervalMinutes)} 分钟）`
      );
    }
  }

  const qualified =
    retests.length >= REQUIRED_RETESTS &&
    latestTwo.length === REQUIRED_RETESTS &&
    differentOperator &&
    intervalOk;

  return {
    required: REQUIRED_RETESTS,
    submitted: retests.length,
    validCurveCount: validCurveRetests.length,
    differentOperator,
    intervalMinutes,
    intervalRequiredMinutes: RETEST_INTERVAL_MINUTES,
    intervalOk,
    qualified,
    unmet: missing
  };
}

function releaseStateLabel(state) {
  return {
    awaiting_curve: "释放登记成功，等待六时点扭矩记录",
    recording: "扭矩记录中",
    residual_denied: "残余扭矩高于满弦扭矩一成，拒绝拆机",
    rebound_held: "后三次出现回升，需换人复测两次且间隔四小时",
    admitted: "拆机准入通过",
    superseded: "已被新版本取代（更换发条/更正释放值），结论以新版本为准"
  }[state];
}

// 核心：由一张释放单 + 读数 + 复测实时派生准入结论。
// 注意：不依赖 status/closeReason 字段得出业务结论——即使存储状态滞后，
// 刷新后依旧与列表、履历一致。status 只用于“能否继续写入/是否只读”。
function evaluateOrder(order, readings, retests) {
  if (order.superseded) {
    return {
      state: "superseded",
      active: false,
      admitted: false,
      finished: true,
      canDisassemble: false,
      readOnly: true,
      residualAllowed: null,
      curve: evaluateCurve(readings),
      retests: evaluateRetests(order, retests, readings),
      message: releaseStateLabel("superseded")
    };
  }

  const residualAllowed = !residualExceedsLimit(order.fullWindTorque, order.residualTorque);
  if (!residualAllowed) {
    const ratio = order.residualTorque / order.fullWindTorque;
    return {
      state: "residual_denied",
      active: false,
      admitted: false,
      finished: true,
      canDisassemble: false,
      readOnly: true,
      residualAllowed: false,
      residualRatio: Number(ratio.toFixed(4)),
      residualLimit: RESIDUAL_RATIO_LIMIT,
      curve: evaluateCurve(readings),
      retests: evaluateRetests(order, retests, readings),
      message: releaseStateLabel("residual_denied")
    };
  }

  const curve = evaluateCurve(readings);
  if (!curve.complete) {
    return {
      state: readings.length === 0 ? "awaiting_curve" : "recording",
      active: true,
      admitted: false,
      finished: false,
      canDisassemble: false,
      readOnly: false,
      residualAllowed: true,
      residualRatio: Number((order.residualTorque / order.fullWindTorque).toFixed(4)),
      residualLimit: RESIDUAL_RATIO_LIMIT,
      recordedPoints: readings.length,
      totalPoints: TOTAL_POINTS,
      curve,
      retests: evaluateRetests(order, retests, readings),
      message: readings.length === 0 ? releaseStateLabel("awaiting_curve") : releaseStateLabel("recording")
    };
  }

  if (curve.rebound) {
    const retestSummary = evaluateRetests(order, retests, readings);
    if (retestSummary.qualified) {
      return {
        state: "admitted",
        active: false,
        admitted: true,
        finished: true,
        canDisassemble: true,
        readOnly: true,
        residualAllowed: true,
        curve,
        retests: retestSummary,
        clearedByRetests: true,
        message: "复测合格，回升解除，拆机准入通过"
      };
    }
    return {
      state: "rebound_held",
      active: true,
      admitted: false,
      finished: false,
      canDisassemble: false,
      readOnly: false,
      residualAllowed: true,
      curve,
      retests: retestSummary,
      message: releaseStateLabel("rebound_held")
    };
  }

  return {
    state: "admitted",
    active: false,
    admitted: true,
    finished: true,
    canDisassemble: true,
    readOnly: true,
    residualAllowed: true,
    curve,
    retests: evaluateRetests(order, retests, readings),
    message: releaseStateLabel("admitted")
  };
}

// 一只表当前拆机准入：只看最新版本释放单；旧版本永不复活。
function evaluateClock(clockId, orders, readingsByOrder, retestsByOrder) {
  const latest = orders
    .filter((item) => item.clockId === clockId)
    .sort((a, b) => b.version - a.version)[0];

  if (!latest) {
    return {
      hasReleaseOrder: false,
      latestVersion: 0,
      state: "no_release",
      admitted: false,
      canDisassemble: false,
      message: "尚未登记发条释放单，不准拆机"
    };
  }

  const result = evaluateOrder(
    latest,
    readingsByOrder.get(latest.id) || [],
    retestsByOrder.get(latest.id) || []
  );

  return {
    hasReleaseOrder: true,
    latestVersion: latest.version,
    latestOrderId: latest.id,
    state: result.state,
    admitted: result.admitted,
    canDisassemble: result.canDisassemble,
    message: result.message,
    detail: result
  };
}

module.exports = {
  RESIDUAL_RATIO_LIMIT,
  TOTAL_POINTS,
  CHECKED_POINTS,
  REQUIRED_RETESTS,
  RETEST_INTERVAL_MINUTES,
  REVISION_REASONS,
  httpError,
  isFiniteNumber,
  validateRegistration,
  residualExceedsLimit,
  evaluateCurve,
  retestCurveOk,
  minutesBetween,
  evaluateRetests,
  evaluateOrder,
  evaluateClock,
  releaseStateLabel
};
