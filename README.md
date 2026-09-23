# 机械钟表擒纵调校与发条释放拆机准入 API

纯后端零依赖 Node 服务，使用 `data/db.json` 持久化。除钟表档案、调校记录、
复测记录外，还提供**发条扭矩释放与拆机准入台**。

## 启动

```bash
PORT=3021 node server.js
```

## 代码结构

发条释放/拆机准入业务拆在 `src/` 下三个文件，`server.js` 只做薄壳挂载：

| 文件 | 职责 |
| --- | --- |
| `src/releaseRoutes.js` | 请求入口：HTTP 路由、参数解析、按钟表维度串行化写操作 |
| `src/releaseRules.js` | 判定规则：纯函数，准入结论全部由此现算（列表/履历/刷新共用） |
| `src/releaseStore.js` | 记录存储：`db.json` 读写、ID 生成、并发锁与初始数据播种 |

## 走时调校接口

- `GET /health`
- `GET /clocks` / `POST /clocks`
- `GET /clocks/not-qualified`
- `GET /clocks/:id/history`
- `POST /clocks/:id/adjustments`
- `POST /clocks/:id/retests`
- `GET /clocks/:id/latest-retest`
- `GET /adjustments?clockId=`
- `GET /retests?clockId=&qualified=`

## 发条释放与拆机准入接口

- `POST /clocks/:id/releases` 登记释放单（满弦扭矩、残余扭矩、静置分钟、释放员；可同时带 `torques` 六时点）
- `POST /clocks/:id/releases/readings` 释放后补录六个时点扭矩
- `POST /clocks/:id/releases/retests` 回升后的换人复测
- `POST /clocks/:id/releases/spring` 更换发条（旧单失效只读，按新曲线重算）
- `POST /clocks/:id/releases/correct` 更正释放值（同上；只传需要改的字段，其余沿用）
- `GET /clocks/:id/releases` 单表当前准入结论
- `GET /clocks/:id/releases/history` 单表全部释放单履历（含失效只读单）
- `GET /clocks/:id/releases/:orderId` 单张释放单（含已失效单）
- `GET /releases?clockId=&admission=` 释放单列表

## 判定规则

1. **唯一未结束单**：每只表仅一张生效释放单；重复或并发提交幂等沿用首次结果（按钟表维度串行加锁）。
2. **登记必填**：`fullWindTorque`（>0）、`residualTorque`（≥0）、`restingMinutes`（≥0）、`operator`，缺项返回 400。
3. **残余红线**：残余扭矩 > 满弦扭矩 × 10% 直接拒绝拆机（`rejected`，终态），曲线与复测均不可翻案；等于一成不拒绝。
4. **六时点曲线**：必须恰好 6 个 >0 的数值；后三次（第 4→5、5→6 时点）不得回升。
   - 不回升 → `admitted` 允许拆机。
   - 出现回升 → `blocked` 封锁拆机。
5. **回升复测**：必须换人（复测员 ≠ 释放员），复测曲线后三次同样不得回升；
   有效复测满 **2 次**、相邻两次间隔 **≥4 小时** 才解除封锁转为 `admitted`。
   不满足的复测仍留档但不计入有效次数。
6. **失效重算**：更换发条或更正释放值会新建修订单（`reason` 为 `spring_replace` / `correct`），
   旧单标记 `invalidated: true` 且只读保留，准入只按最新单的新曲线重算。
7. **一致性**：准入状态不持久化为字段，全部由原始释放单/曲线/复测记录现算，
   因此列表、单表履历、刷新后的结论始终一致。

`admission` 取值：`none`（未登记）/ `pending_curve`（待曲线）/ `blocked`（回升封锁）/ `admitted`（允许拆机）/ `rejected`（残余超标）。

## 闭环示例

```bash
# 登记 + 六时点一次提交，曲线不回升即允许拆机
curl -X POST http://127.0.0.1:3021/clocks/clock_demo/releases/correct \
  -H 'Content-Type: application/json' \
  -d '{"residualTorque":0.6,"torques":[9.2,8.4,7.6,6.8,6.2,5.6]}'

# 出现回升时换人复测（两次、间隔四小时）
curl -X POST http://127.0.0.1:3021/clocks/clock_demo/releases/retests \
  -H 'Content-Type: application/json' \
  -d '{"operator":"李师傅","torques":[9,8,7,6,5,4],"testedAt":"2026-09-23T14:00:00Z"}'
```
