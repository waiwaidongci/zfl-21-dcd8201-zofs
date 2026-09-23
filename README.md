# 机械钟表擒纵调校 API（含发条扭矩释放与拆机准入）

纯后端零依赖 Node 服务，使用 `data/db.json` 持久化。代码按职责拆在三个业务文件：

- `src/store.js` — 记录存储：JSON 持久化、全局写互斥（并发提交串行化）、数据查询
- `src/rules.js` — 判定规则：纯函数，所有准入结论由记录实时派生
- `src/routes.js` — 请求入口：HTTP 解析、幂等登记、只读校验、列表与履历
- `server.js` — 仅启动引导

## 启动

```bash
PORT=3021 node server.js
```

## 原有调校接口

- `GET /health`、`GET /clocks`、`POST /clocks`、`GET /clocks/not-qualified`
- `GET /clocks/:id/history`
- `POST /clocks/:id/adjustments`、`POST /clocks/:id/retests`
- `GET /clocks/:id/latest-retest`、`GET /adjustments`、`GET /retests`

## 发条释放与拆机准入接口

- `POST /clocks/:id/release-orders` — 登记释放单（满弦扭矩、释放后残余扭矩、静置分钟、释放员）
- `POST /clocks/:id/release-orders/revisions` — 更换发条（`reason=mainspring_replacement`）或更正释放值（`reason=release_value_correction`）
- `POST /release-orders/:id/torque-readings` — 记录释放后六个时点扭矩
- `POST /release-orders/:id/retests` — 回升后的换人复测
- `GET /release-orders?clockId=&state=&admitted=` — 释放单列表
- `GET /release-orders/:id` — 单张释放单（含实时结论）
- `GET /clocks/:id/release-history` — 单表全部版本履历与当前准入结论

## 判定规则

1. **唯一未结束单**：每只表仅一张未结束释放单。重复或并发提交沿用首次结果（HTTP 200 + `reused:true`）；并发由全局写锁串行化，先到者建单。
2. **登记校验**：满弦扭矩、残余扭矩、静置分钟、释放员缺一即 400 拒绝，扭矩必须为非负数。
3. **一成残余**：释放后残余扭矩严格高于满弦扭矩一成（`residual > full * 0.1`）时拒绝拆机，单据直接结束为 `residual_denied`；恰为一成放行。
4. **六时点曲线**：释放后按六个时点记录扭矩，**后三次（第 4/5/6 时点）不得回升**（允许持平）。全部记录且单调即准入；出现回升进入 `rebound_held`。
5. **回升复测**：必须**换人**（复测员不同于释放员）复测**两次**，两次间隔至少 **4 小时**，且复测曲线后三次同样不回升，方可解除并准入。
6. **换发条 / 更正释放值**：旧释放单立即失效（只读，状态 `superseded`），按新参数生成新版本并依新曲线重算；准入只看最新版本，旧记录不可改，仅可查。
7. **一致性**：列表、单表履历、刷新后的结论都由同一组纯函数从记录实时计算，不做缓存。

## 闭环示例

```bash
# 登记（重复提交返回同一张单）
curl -X POST http://127.0.0.1:3021/clocks/clock_demo/release-orders \
  -H 'Content-Type: application/json' \
  -d '{"fullWindTorque":320,"residualTorque":20,"restingMinutes":45,"releasedBy":"李师傅"}'

# 六个时点（可逐点，可一次批量）
curl -X POST http://127.0.0.1:3021/release-orders/<orderId>/torque-readings \
  -H 'Content-Type: application/json' \
  -d '{"torques":[305,272,244,216,190,166]}'

# 若后三次回升：换人复测，两次间隔 >= 4 小时
curl -X POST http://127.0.0.1:3021/release-orders/<orderId>/retests \
  -H 'Content-Type: application/json' \
  -d '{"testedBy":"赵师傅","measuredAt":"2026-09-23T12:00:00Z","torques":[300,270,240,210,185,160]}'

# 更换发条：旧版本只读失效，按新曲线重算
curl -X POST http://127.0.0.1:3021/clocks/clock_demo/release-orders/revisions \
  -H 'Content-Type: application/json' \
  -d '{"reason":"mainspring_replacement","fullWindTorque":300,"residualTorque":18,"restingMinutes":30,"releasedBy":"李师傅"}'

# 列表 / 履历 / 刷新结论一致
curl 'http://127.0.0.1:3021/release-orders?admitted=true'
curl http://127.0.0.1:3021/clocks/clock_demo/release-history
```
