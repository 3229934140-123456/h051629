export interface ServerConfig {
  port: number;
  tickRate: number;
  maxRooms: number;
  maxPlayersPerRoom: number;
  snapshotInterval: number;
  deltaSyncInterval: number;
  inputBufferSize: number;
  reconnectTimeoutMs: number;
  slowOperationTimeoutMs: number;
  maxHistorySnapshots: number;
}

export const DEFAULT_CONFIG: ServerConfig = {
  port: 8080,
  tickRate: 60,
  maxRooms: 100,
  maxPlayersPerRoom: 8,
  snapshotInterval: 100,
  deltaSyncInterval: 16,
  inputBufferSize: 3,
  reconnectTimeoutMs: 30000,
  slowOperationTimeoutMs: 50,
  maxHistorySnapshots: 120,
};

export enum MessageType {
  HANDSHAKE = 0,
  HANDSHAKE_ACK = 1,
  JOIN_ROOM = 10,
  JOIN_ROOM_ACK = 11,
  LEAVE_ROOM = 12,
  PLAYER_INPUT = 20,
  STATE_SNAPSHOT = 30,
  STATE_DELTA = 31,
  STATE_FULL = 32,
  CORRECTION = 33,
  PING = 40,
  PONG = 41,
  RECONNECT = 50,
  RECONNECT_ACK = 51,
  JOIN_SPECTATOR = 60,
  JOIN_SPECTATOR_ACK = 61,
  LEAVE_SPECTATOR = 62,
  ROOM_EVENT = 63,
  ROOM_EVENTS_QUERY = 64,
  ROOM_EVENTS_QUERY_ACK = 65,
  ROOM_PAUSE = 70,
  ROOM_RESUME = 71,
  ROOM_STATUS = 72,
  ROOM_STATUS_SIMPLE = 73,
  KICK_PLAYER = 74,
  LOCK_ROOM = 75,
  UNLOCK_ROOM = 76,
  SYSTEM_ANNOUNCEMENT = 77,
  CHAT_MESSAGE = 80,
  ERROR = 99,
}

export enum RoomEventType {
  PLAYER_JOINED = 'player_joined',
  PLAYER_LEFT = 'player_left',
  PLAYER_DISCONNECTED = 'player_disconnected',
  PLAYER_RECONNECTED = 'player_reconnected',
  PLAYER_KICKED = 'player_kicked',
  SPECTATOR_JOINED = 'spectator_joined',
  SPECTATOR_LEFT = 'spectator_left',
  ROOM_PAUSED = 'room_paused',
  ROOM_RESUMED = 'room_resumed',
  ROOM_LOCKED = 'room_locked',
  ROOM_UNLOCKED = 'room_unlocked',
  SYSTEM_ANNOUNCEMENT = 'system_announcement',
}

export enum RoomEventCategory {
  PLAYER = 'player',
  SPECTATOR = 'spectator',
  ADMIN = 'admin',
  SYSTEM = 'system',
}

export enum ReconnectStatus {
  FRESH = 'fresh',
  NORMAL = 'normal',
  WARNING = 'warning',
  EXPIRED = 'expired',
}

export enum AnnouncementTarget {
  ALL = 'all',
  PLAYERS_ONLY = 'players_only',
  SPECTATORS_ONLY = 'spectators_only',
}

export interface RoomEvent {
  id: string;
  type: RoomEventType;
  category: RoomEventCategory;
  timestamp: number;
  frame: number;
  actorId?: string;
  actorType?: 'player' | 'spectator' | 'admin' | 'system';
  data: Record<string, unknown>;
  snapshot?: {
    playerCount: number;
    spectatorCount: number;
    isPaused: boolean;
    isLocked: boolean;
    currentFrame: number;
  };
}

export interface NetworkMessage<T = unknown> {
  type: MessageType;
  seq?: number;
  timestamp: number;
  payload: T;
}

export interface PlayerConnection {
  id: string;
  sessionId: string;
  roomId: string | null;
  isConnected: boolean;
  joinedAt: number;
  lastActivity: number;
  rtt: number;
  lastReceivedSeq: number;
  lastSentSeq: number;
}

export interface PlayerInput {
  playerId: string;
  frame: number;
  inputData: InputData;
  timestamp: number;
  predictedPosition?: { x: number; y: number; z?: number };
  predictedVelocity?: { x: number; y: number; z?: number };
}

export interface InputData {
  moveX?: number;
  moveY?: number;
  action1?: boolean;
  action2?: boolean;
  aimX?: number;
  aimY?: number;
  custom?: Record<string, unknown>;
}

export interface PlayerState {
  id: string;
  position: { x: number; y: number; z?: number };
  velocity?: { x: number; y: number; z?: number };
  rotation?: { x: number; y: number; z?: number };
  health: number;
  custom?: Record<string, unknown>;
}

export interface GameState {
  frame: number;
  timestamp: number;
  players: Map<string, PlayerState>;
  worldState?: Record<string, unknown>;
}

export interface StateDelta {
  frame: number;
  baseFrame: number;
  playerUpdates: Map<string, Partial<PlayerState>>;
  worldUpdates?: Record<string, unknown>;
  removedPlayers?: string[];
}

export interface HistorySnapshot {
  frame: number;
  state: GameState;
  inputs: Map<string, PlayerInput>;
}

export interface RoomState {
  id: string;
  name: string;
  players: Map<string, PlayerConnection>;
  currentFrame: number;
  isRunning: boolean;
  createdAt: number;
}
