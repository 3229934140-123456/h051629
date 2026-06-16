# 实时多人游戏服务器框架 - 架构说明

## 目录

1. [整体架构概览](#整体架构概览)
2. [模块详解](#模块详解)
   - [网络层 (NetworkLayer)](#网络层-networklayer)
   - [房间管理 (RoomManager)](#房间管理-roommanager)
   - [游戏循环 (GameLoop)](#游戏循环-gameloop)
   - [输入缓冲 (InputBuffer)](#输入缓冲-inputbuffer)
   - [状态同步 (StateSynchronizer)](#状态同步-statesynchronizer)
   - [延迟补偿 (LagCompensation)](#延迟补偿-lagcompensation)
3. [核心问题解答](#核心问题解答)
4. [消息协议格式](#消息协议格式)
5. [快速开始](#快速开始)

---

## 整体架构概览

本框架采用分层模块化设计，核心架构如下：

```
┌─────────────────────────────────────────────────────────────┐
│                      GameServer (入口)                      │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐   │
│  │  NetworkLayer│───▶│  RoomManager │───▶│   Room (N)   │   │
│  │  (网络层)    │    │  (房间管理)  │    │  (房间实例)  │   │
│  └──────────────┘    └──────────────┘    └──────┬───────┘   │
│                                                │           │
│                         ┌──────────────────────┤           │
│                         │                      │           │
│                  ┌──────▼──────┐      ┌───────▼──────┐    │
│                  │  GameLoop   │      │InputBuffer   │    │
│                  │ (游戏循环)  │      │ (输入缓冲)   │    │
│                  └──────┬──────┘      └───────┬──────┘    │
│                         │                      │           │
│                  ┌──────▼──────┐      ┌───────▼──────┐    │
│                  │StateSync    │◀────▶│LagCompensat. │    │
│                  │(状态同步)   │      │(延迟补偿)    │    │
│                  └─────────────┘      └──────────────┘    │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### 设计原则

1. **房间隔离**：每个房间独立运行，有独立的游戏循环、状态、输入缓冲，互不影响
2. **固定帧率**：采用固定时间步长（Fixed Timestep）的游戏循环，保证逻辑确定性
3. **权威服务端**：服务端是唯一权威，所有游戏逻辑在服务端执行，客户端只做表现层预测
4. **帧同步+状态同步混合**：输入按帧处理，状态采用快照+增量混合同步
5. **非阻塞设计**：所有潜在慢操作都采用异步队列，不阻塞游戏主循环

---

## 模块详解

### 网络层 (NetworkLayer)

**文件**：[NetworkLayer.ts](file:///d:/trae-bz/TraeProjects/29/src/network/NetworkLayer.ts)

#### 核心职责

- 管理 WebSocket 连接生命周期
- 消息的序列化/反序列化（使用 MessagePack 二进制协议）
- 连接心跳与超时检测
- 消息序号管理与 ACK 确认机制
- RTT（往返延迟）测量

#### 关键设计

**1. 连接标识**
每个连接有两个ID：
- `connectionId`：物理连接ID，每次重新连接会变化
- `sessionId`：逻辑会话ID，用于断线重连时识别身份

**2. 消息序列化**
采用 MessagePack 替代 JSON，优势：
- 体积减少 30-50%
- 序列化/反序列化速度更快
- 支持二进制数据直接传输

**3. 心跳机制**
```
每10秒 → 服务端发送 PING
         ↓
客户端回复 PONG（带原始时间戳）
         ↓
服务端计算 RTT = 当前时间 - 原始时间戳
```
如果30秒无任何活动 → 判定连接超时，触发断线流程

**4. 可靠消息机制**
```typescript
send(connectionId, message, requireAck = true);
// 如果 requireAck = true：
//   - 消息带有序号 seq
//   - 等待客户端 ACK 回复
//   - 5秒超时未收到 → Promise reject
```

---

### 房间管理 (RoomManager)

**文件**：[RoomManager.ts](file:///d:/trae-bz/TraeProjects/29/src/room/RoomManager.ts)

#### 核心职责

- 房间的创建/查找/销毁生命周期管理
- 客户端连接 → 房间的分配策略
- 玩家加入/离开路由
- 断线重连的会话恢复
- 多房间并发调度

#### 关键设计

**1. 客户端连接如何分配到房间**

分配策略优先级（可配置）：
```
客户端请求 JOIN_ROOM
    ↓
指定 roomId? ──是──▶ 直接加入指定房间
    │否
    ▼
createIfNotExists=false? ──是──▶ 查找匹配的公开房间
    │否
    ▼
查找同 gameMode 且未满的公开房间
    │找不到
    ▼
创建新房间（未达 maxRooms 上限时）
```

相关代码见 [RoomManager.handleJoinRoom](file:///d:/trae-bz/TraeProjects/29/src/room/RoomManager.ts#L293-L333)

**2. 多房间如何并发不互相影响**

每个 `Room` 实例拥有完全独立的：
- ✅ 独立的 `GameLoop`（独立定时器，独立帧率计算）
- ✅ 独立的 `InputBuffer`（玩家输入互不干扰）
- ✅ 独立的 `StateSynchronizer`（状态历史独立存储）
- ✅ 独立的 `LagCompensation`（回滚计算独立）
- ✅ 独立的同步定时器（快照/增量更新独立调度）

Node.js 的事件循环机制天然保证：**同一时刻只有一个房间的 JavaScript 代码在执行**，但由于：
- 所有 I/O 操作都是异步非阻塞的
- 游戏循环使用 `setTimeout` 让出事件循环
- 慢操作放入独立队列用 `Promise.race` 超时控制

因此多个房间之间可以公平地交错执行，不会出现一个房间阻塞其他房间的情况。

**3. 房间自动清理策略**
```
玩家离开房间
    ↓
房间变为空
    ↓
启动 30 秒倒计时
    ↓
倒计时结束仍为空 → 自动销毁房间
```

---

### 游戏循环 (GameLoop)

**文件**：[GameLoop.ts](file:///d:/trae-bz/TraeProjects/29/src/loop/GameLoop.ts)

#### 核心职责

- 固定帧率的游戏逻辑循环驱动
- 累积时间补偿（处理帧率波动）
- 游戏逻辑的超时防护
- 慢操作异步队列调度

#### 关键设计

**1. 每个房间如何独立运行固定帧率的逻辑循环**

采用经典的 **固定时间步长 + 累加器** 模式：

```typescript
const TICK_INTERVAL = 1000 / 60;  // 16.666ms per frame @ 60Hz
let accumulator = 0;
let lastFrameTime = now();

function loop() {
  const currentTime = now();
  const frameTime = currentTime - lastFrameTime;  // 实际耗时
  lastFrameTime = currentTime;
  
  accumulator += frameTime;
  
  // 固定步长推进，可能一次跑多帧追赶
  while (accumulator >= TICK_INTERVAL) {
    processFrame();     // 处理一帧逻辑
    accumulator -= TICK_INTERVAL;
  }
  
  setTimeout(loop, Math.max(0, TICK_INTERVAL - accumulator));
}
```

**优势**：
- 逻辑帧率完全固定（确定性），不受渲染帧率影响
- 即使某次循环延迟了，也会跑多帧补回来（不会整体慢下来）
- 每帧传给游戏逻辑的 `deltaTime` 是固定值

相关代码见 [GameLoop.runLoop](file:///d:/trae-bz/TraeProjects/29/src/loop/GameLoop.ts#L77-L102)

**2. 一个慢操作如何不阻塞整个房间循环**

**三层防护机制**：

| 层级 | 机制 | 阈值 | 说明 |
|------|------|------|------|
| L1 | 游戏逻辑超时 | `slowOperationTimeoutMs`(默认50ms) | 用 `Promise.race` 强制超时，超时后使用上一帧状态继续 |
| L2 | 慢操作队列 | 并发≤4 | 复杂操作（如AI计算、数据库查询）通过 `queueSlowOperation()` 放入异步队列 |
| L3 | 帧耗时告警 | 同L1阈值 | 日志警告，便于排查性能问题 |

```typescript
// 好的做法：把慢操作放入队列
const result = await gameLoop.queueSlowOperation(async () => {
  return await database.query(/* 慢查询 */);
}, 5000);  // 5秒超时

// 坏的做法：直接在逻辑里阻塞
const result = await database.query(/* 慢查询 */);  // ❌ 会阻塞整个房间
```

相关代码见 [GameLoop.processFrame](file:///d:/trae-bz/TraeProjects/29/src/loop/GameLoop.ts#L104-L155) 和 [GameLoop.queueSlowOperation](file:///d:/trae-bz/TraeProjects/29/src/loop/GameLoop.ts#L213-L240)

---

### 输入缓冲 (InputBuffer)

**文件**：[InputBuffer.ts](file:///d:/trae-bz/TraeProjects/29/src/input/InputBuffer.ts)

#### 核心职责

- 客户端输入的帧对齐缓冲
- 丢帧时的输入预测
- 缓冲裁剪防止内存溢出
- 为确定性逻辑提供统一的帧输入

#### 关键设计

**1. 客户端输入如何缓冲到帧边界统一处理保证确定性**

**核心思想**：所有输入都打上目标帧号，到达帧边界时一次性取出所有该帧的输入处理。

```
时间线 →
客户端 A:  [输入F100] ──────────────────▶ [到达服务端]
客户端 B:     ────────── [输入F100] ────▶ [到达服务端]
服务端:                              F100边界
                                          ↓
                            InputBuffer.getInputsForFrame(100)
                                          ↓
                        统一取出 A和B 的F100输入 → 游戏逻辑处理
```

**确定性保证**：
1. **按帧号而非到达时间处理**：无论输入先到后到，只要帧号相同，就在同一帧处理
2. **玩家顺序固定**：按 `playerId` 字典序遍历，与输入到达顺序无关
3. **丢帧不中断**：缺少输入时用上一帧输入预测（见下文）

相关代码见 [InputBuffer.getInputsForFrame](file:///d:/trae-bz/TraeProjects/29/src/input/InputBuffer.ts#L47-L81)

**2. 丢帧/延迟输入的处理**

当某玩家在某帧没有输入时（网络丢包或延迟），采用**最近输入外推**：
```typescript
// 从最近的历史帧回溯，找到最后一个收到的输入
for (let f = frame - 1; f >= 0; f--) {
  const entry = buffer.get(f);
  if (entry) return clone(entry.inputData);  // 复制作为预测输入
}
// 完全没历史 → 返回零输入
return { moveX: 0, moveY: 0, action1: false };
```

这保证了：即使网络抖动，游戏也不会"卡住"等输入，而是平滑继续。

---

### 状态同步 (StateSynchronizer)

**文件**：[StateSynchronizer.ts](file:///d:/trae-bz/TraeProjects/29/src/sync/StateSynchronizer.ts)

#### 核心职责

- 游戏状态的存储与版本管理
- 全量快照生成
- 增量更新（Delta）计算
- 历史快照回滚（用于延迟补偿）
- 断线恢复的状态序列化

#### 关键设计

**1. 游戏状态如何同步给房间内所有客户端**

采用 **全量快照 + 增量更新混合策略**：

| 同步类型 | 发送时机 | 适用场景 | 优势 |
|---------|---------|---------|------|
| 全量快照 (STATE_FULL) | 每 `snapshotInterval`(默认100ms)，或断线重连 | 新玩家加入、定期兜底、状态差异过大 | 无需基准，容错性强 |
| 增量更新 (STATE_DELTA) | 每 `deltaSyncInterval`(默认16ms) | 正常游戏过程 | 体积小，带宽省 |

```
时间线 →
T+0ms:   发送 STATE_FULL (帧100)  ← 基准帧
T+16ms:  发送 STATE_DELTA (帧101, base=100)
T+32ms:  发送 STATE_DELTA (帧102, base=101)
T+48ms:  发送 STATE_DELTA (帧103, base=102)
...
T+100ms: 发送 STATE_FULL (帧106)  ← 重新校准基准
```

**2. 全量快照与增量更新的权衡**

| 维度 | 全量快照 | 增量更新 |
|------|---------|---------|
| 带宽占用 | 高（完整状态） | 低（只传变化的字段） |
| 客户端计算 | 简单（直接替换） | 需要基准帧合并 |
| 丢包影响 | 无（自包含） | 丢了需要等下一个快照 |
| 内存需求 | 服务端低 | 需要保留历史快照 |
| 实现复杂度 | 低 | 高（差异计算、基准管理） |

**推荐配置**：
- 高带宽（本地/LAN）：提高快照频率，减少Delta压力
- 低带宽（公网/移动）：降低快照频率，提高Delta频率
- 慢节奏游戏（回合制）：只用全量快照即可
- 快节奏游戏（FPS/格斗）：两者混合

增量差异计算代码见 [StateSynchronizer.generateDelta](file:///d:/trae-bz/TraeProjects/29/src/sync/StateSynchronizer.ts#L93-L154)

**3. 断线重连如何快速恢复状态**

```
客户端断线
    ↓
服务端：保留会话 + 启动30秒重连窗口（不销毁玩家状态）
    ↓
客户端重连，发送 RECONNECT(sessionId, lastKnownFrame=250)
    ↓
服务端校验 sessionId → 找到对应玩家
    ↓
发送 RECONNECT_ACK：
{
  state: 完整的当前状态（帧280）,
  baseFrame: 250,
  currentFrame: 280,
  missedFrames: 30
}
    ↓
客户端：用完整状态替换本地状态，跳到帧280继续
```

**为什么发送完整状态而不是30帧的Delta？**
1. 完整状态发送一次，无需客户端有正确的基准帧
2. 避免连锁丢包：如果30帧Delta中有任何一帧丢了，整个重放失败
3. 实现简单可靠：重连属于低频操作，带宽开销可以接受

相关代码见 [Room.handleReconnect](file:///d:/trae-bz/TraeProjects/29/src/room/RoomManager.ts#L184-L223)

---

### 延迟补偿 (LagCompensation)

**文件**：[LagCompensation.ts](file:///d:/trae-bz/TraeProjects/29/src/sync/LagCompensation.ts)

#### 核心职责

- 历史状态的时间回滚（服务端回滚）
- 玩家状态的帧间插值
- 命中检测的延迟补偿
- 客户端预测误差计算与校正

#### 关键设计

**1. 网络延迟如何补偿（客户端预测 + 服务端校正）**

采用经典的 **客户端预测-服务端权威** 架构：

```
┌─────────────┐                    ┌─────────────┐
│   客户端    │                    │   服务端    │
└──────┬──────┘                    └──────┬──────┘
       │ 玩家按下"前进"                   │
       ▼                                   │
  [1] 本地预测：角色立刻向前移动            │
       │ 发送 PLAYER_INPUT(frame=100)      │
       ├──────────────────────────────────▶│
       │                           [2] 权威计算
       │                           角色向前移动
       │  发送 STATE_DELTA / CORRECTION   │
       │◀──────────────────────────────────┤
       ▼                                   │
  [3] 校验本地预测 vs 服务端权威            │
       │                                   │
       ├─ 误差 < 阈值 → 平滑过渡，不修正    │
       │                                   │
       └─ 误差 > 阈值 → 强制校正到服务端位置│
```

**服务端校正生成**：
服务端每帧检查玩家的 ACK（已确认帧）和当前帧的差异：
```typescript
if (|服务端当前帧 - 客户端估算帧| > 30帧) {
  生成 CORRECTION 消息 {
    serverFrame: 当前帧,
    baseFrame: 客户端最后确认的帧,
    position: 服务端权威位置,
    velocity: 服务端权威速度
  }
}
```

相关代码见 [Room.checkAndSendCorrections](file:///d:/trae-bz/TraeProjects/29/src/room/RoomManager.ts#L308-L337) 和 [LagCompensation.generateCorrectionPayload](file:///d:/trae-bz/TraeProjects/29/src/sync/LagCompensation.ts#L108-L131)

**2. 命中检测的回滚补偿（针对射击类游戏）**

当服务端收到"开火"命令，使用客户端的时间戳回滚历史状态：
```
玩家A（延迟200ms）开火瞄准玩家B的头
    ↓
服务端收到命令时，B已经移动了200ms ≈ 12帧
    ↓
LagCompensation.rewindToTime(
  history,
  targetId=B,
  clientTimestamp=开火时间,
  serverCurrentTime=现在
)
    ↓
回到12帧前的历史状态 → B在A瞄准时的实际位置
    ↓
用这个位置做命中检测 → 公平！
```

回滚插值代码见 [LagCompensation.interpolatePlayerState](file:///d:/trae-bz/TraeProjects/29/src/sync/LagCompensation.ts#L48-L106)

---

## 核心问题解答

### Q1: 客户端连接如何分配到房间？
见 **房间管理** 章节的 [分配策略](###房间管理-RoomManager)。支持：指定房间ID、自动匹配公开房间、按需创建新房间。

### Q2: 每个房间如何独立运行固定帧率的逻辑循环？
每个 `Room` 拥有独立的 `GameLoop` 实例，使用固定步长 + 累加器模式。Node.js 事件循环通过 `setTimeout` 让出时间片，使得多个房间的循环可以交错执行，互不阻塞。详细实现见 **游戏循环** 章节。

### Q3: 客户端输入如何缓冲到帧边界统一处理保证确定性？
- 所有客户端输入必须带 `frame`（目标帧号）
- 服务端 `InputBuffer` 按 `playerId → frame → input` 三级存储
- 到达帧边界时，`getInputsForFrame(frame)` 一次性取出所有玩家该帧的输入
- 按固定顺序（playerId字典序）遍历处理，与网络到达顺序无关
- 缺失输入时用最近历史预测，避免中断

### Q4: 游戏状态如何同步给房间内所有客户端（全量快照与增量更新的权衡）？
- **正常同步**：每16ms发送增量更新（只传变化字段），带宽高效
- **定期校准**：每100ms发送全量快照，容错兜底
- **新加入/重连**：直接发全量快照，一步到位
- 权衡表格见 **状态同步** 章节

### Q5: 网络延迟如何补偿（客户端预测与服务端校正）？
- **客户端侧**：输入立刻本地预测（乐观执行），不等待服务端
- **服务端侧**：唯一权威，执行相同逻辑，产生权威状态
- **校正机制**：服务端检测到预测误差 > 阈值时，发送 `CORRECTION` 消息
- **射击类额外补偿**：服务端用历史快照回滚到客户端开火时刻做命中判定
- **置信度衰减**：延迟越高的回滚，命中结果置信度越低，可配置是否接受

### Q6: 断线重连如何快速恢复状态？
- 断线后服务端不立刻销毁玩家，保留30秒重连窗口
- 客户端重连时用 `sessionId` 识别身份（不是connectionId）
- 服务端直接发送**完整的当前状态**，而不是补帧Delta
- 客户端一步到位替换本地状态，从当前帧继续游戏
- 30秒超时未重连 → 永久移除玩家

### Q7: 一个慢操作如何不阻塞整个房间循环？
三层防护：
1. **游戏逻辑超时**：每帧逻辑执行有 `slowOperationTimeoutMs`（50ms）硬超时，用 `Promise.race` 终止
2. **慢操作队列**：复杂操作通过 `queueSlowOperation()` 放入异步队列，最多4个并发
3. **空房间自动停止**：玩家全离开后，房间循环自动停止，不浪费CPU

### Q8: 多房间如何并发不互相影响？
- **状态完全隔离**：每个Room有独立的GameLoop、InputBuffer、StateSynchronizer
- **数据零共享**：房间之间除了RoomManager的Map索引，无任何共享状态
- **事件循环调度**：Node.js单线程事件循环天然避免多线程竞态，同时通过setTimeout让出CPU
- **故障隔离**：一个房间的异常（即使是死循环被超时终止）不会影响其他房间

---

## 消息协议格式

所有消息都用 **MessagePack** 二进制序列化，统一结构：

```typescript
interface NetworkMessage<T> {
  type: MessageType;       // 消息类型枚举 (uint8)
  seq?: number;            // 可选序号，用于可靠ACK
  timestamp: number;       // 发送方毫秒时间戳
  payload: T;              // 具体业务数据
}
```

### 主要消息类型

| Type ID | 名称 | 方向 | Payload 说明 |
|---------|------|------|-------------|
| 0 | HANDSHAKE | S→C | 连接ID、会话ID、服务器时间、帧率 |
| 1 | HANDSHAKE_ACK | C→S | 确认握手 |
| 10 | JOIN_ROOM | C→S | roomId?、roomName?、gameMode? |
| 11 | JOIN_ROOM_ACK | S→C | 成功/失败、初始状态、当前帧号 |
| 12 | LEAVE_ROOM | C→S / S→C | 离开原因 |
| 20 | PLAYER_INPUT | C→S | frame、inputData(移动/动作等) |
| 30 | STATE_SNAPSHOT | S→C | 通用状态包 |
| 31 | STATE_DELTA | S→C | baseFrame、增量变化、删除列表 |
| 32 | STATE_FULL | S→C | 完整游戏状态 |
| 33 | CORRECTION | S→C | 校正帧、权威位置/速度 |
| 40 | PING | S→C | 心跳包 |
| 41 | PONG | C→S | 带原始时间戳用于RTT计算 |
| 50 | RECONNECT | C→S | sessionId、lastKnownFrame |
| 51 | RECONNECT_ACK | S→C | 完整恢复状态、帧范围 |
| 99 | ERROR | S→C | 错误消息文本 |

---

## 快速开始

### 安装依赖
```bash
cd d:\trae-bz\TraeProjects\29
npm install
```

### 启动开发服务器
```bash
npm run dev
```

### 构建生产版本
```bash
npm run build
npm start
```

### 自定义游戏逻辑

```typescript
import { GameServer } from './src';
import { PlayerInput, PlayerState } from './src/types';

const server = new GameServer({
  port: 8080,
  tickRate: 60,
  maxRooms: 50,
  maxPlayersPerRoom: 10,
});

// 先启动服务器
server.start();

// 等待房间创建（或通过客户端JOIN_ROOM触发创建）
setTimeout(() => {
  const roomManager = server.getRoomManager();
  const room = roomManager.createRoom({ name: 'TestRoom', gameMode: 'deathmatch' });
  
  // 自定义游戏逻辑回调
  room.gameLoop.setGameLogic((frame, deltaTime, inputs, currentStates) => {
    const newStates = new Map<string, PlayerState>();
    
    for (const [playerId, state] of currentStates) {
      const playerInputs = inputs.get(playerId) || [];
      const newState = { ...state };
      
      // 你的自定义逻辑：处理技能、碰撞、伤害、AI等
      for (const input of playerInputs) {
        if (input.inputData.action1) {
          // 玩家按下了技能键
        }
      }
      
      newStates.set(playerId, newState);
    }
    
    return newStates;
  });
  
  console.log('Custom game logic registered for room:', room.id);
}, 1000);
```

### 环境变量配置

| 变量名 | 默认值 | 说明 |
|--------|--------|------|
| PORT | 8080 | WebSocket监听端口 |
| TICK_RATE | 60 | 游戏逻辑帧率(Hz) |

---

## 性能调优建议

1. **帧率**：
   - 快节奏FPS：60Hz
   - MOBA/RTS：30Hz足够
   - 慢节奏策略：10-20Hz

2. **同步频率**：
   - 带宽充足：`snapshotInterval=50ms`, `deltaSyncInterval=16ms`
   - 带宽有限：`snapshotInterval=200ms`, `deltaSyncInterval=33ms`

3. **历史快照**：
   - 正常不需要超过2秒（120帧@60Hz）
   - 延迟补偿需要更长历史时再调大

4. **慢操作**：
   - 任何超过10ms的逻辑都应该放入 `queueSlowOperation`
   - 包括：数据库查询、HTTP请求、复杂AI计算
