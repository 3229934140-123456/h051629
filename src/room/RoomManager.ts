import { EventEmitter } from 'events';
import { v4 as uuidv4 } from 'uuid';
import {
  ServerConfig,
  PlayerConnection,
  MessageType,
  NetworkMessage,
  PlayerState,
  GameState,
  PlayerInput,
} from '../types';
import { NetworkLayer } from '../network/NetworkLayer';
import { InputBuffer } from '../input/InputBuffer';
import { StateSynchronizer } from '../sync/StateSynchronizer';
import { LagCompensation } from '../sync/LagCompensation';
import { GameLoop } from '../loop/GameLoop';

export interface RoomOptions {
  id?: string;
  name?: string;
  maxPlayers?: number;
  isPrivate?: boolean;
  gameMode?: string;
  customData?: Record<string, unknown>;
}

class Room {
  id: string;
  name: string;
  maxPlayers: number;
  isPrivate: boolean;
  gameMode: string;
  customData: Record<string, unknown>;
  players: Map<string, PlayerConnection> = new Map();
  createdAt: number;

  inputBuffer: InputBuffer;
  stateSynchronizer: StateSynchronizer;
  lagCompensation: LagCompensation;
  gameLoop: GameLoop;
  isRunning = false;

  private lastDeltaFrame: Map<string, number> = new Map();
  private playerAckedFrames: Map<string, number> = new Map();
  private syncTimer: NodeJS.Timeout | null = null;
  private deltaSyncTimer: NodeJS.Timeout | null = null;
  private network: NetworkLayer;
  private config: ServerConfig;
  private reconnectingSessions: Map<string, { playerId: string; timeout: NodeJS.Timeout }> = new Map();

  constructor(
    options: RoomOptions,
    network: NetworkLayer,
    config: ServerConfig
  ) {
    this.id = options.id ?? uuidv4();
    this.name = options.name ?? `Room-${this.id.substring(0, 8)}`;
    this.maxPlayers = options.maxPlayers ?? config.maxPlayersPerRoom;
    this.isPrivate = options.isPrivate ?? false;
    this.gameMode = options.gameMode ?? 'default';
    this.customData = options.customData ?? {};
    this.createdAt = Date.now();
    this.network = network;
    this.config = config;

    this.inputBuffer = new InputBuffer(config);
    this.stateSynchronizer = new StateSynchronizer(config);
    this.lagCompensation = new LagCompensation(config);
    this.gameLoop = new GameLoop(config, this.inputBuffer, this.stateSynchronizer, this.lagCompensation);

    this.setupGameLoopHandlers();
  }

  private setupGameLoopHandlers(): void {
    this.gameLoop.on('frame-complete', ({ frame, state }: { frame: number; state: GameState }) => {
      this.onFrameComplete(frame, state);
    });
  }

  private onFrameComplete(frame: number, _state: GameState): void {
    this.checkAndSendCorrections(frame);
  }

  start(): void {
    if (this.isRunning) return;
    
    this.isRunning = true;
    this.gameLoop.start();
    this.startSyncTimers();
    console.log(`[Room ${this.id}] Started game loop with ${this.players.size} players`);
  }

  stop(): void {
    if (!this.isEmpty()) {
      for (const [playerId] of this.players) {
        this.removePlayer(playerId, 'Room closed');
      }
    }

    this.isRunning = false;
    this.gameLoop.stop();
    this.stopSyncTimers();

    for (const { timeout } of this.reconnectingSessions.values()) {
      clearTimeout(timeout);
    }
    this.reconnectingSessions.clear();

    console.log(`[Room ${this.id}] Stopped`);
  }

  private startSyncTimers(): void {
    this.syncTimer = setInterval(() => {
      this.sendFullSnapshots();
    }, this.config.snapshotInterval);

    this.deltaSyncTimer = setInterval(() => {
      this.sendDeltaUpdates();
    }, this.config.deltaSyncInterval);
  }

  private stopSyncTimers(): void {
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
      this.syncTimer = null;
    }
    if (this.deltaSyncTimer) {
      clearInterval(this.deltaSyncTimer);
      this.deltaSyncTimer = null;
    }
  }

  addPlayer(player: PlayerConnection): { success: boolean; reason?: string } {
    if (this.players.size >= this.maxPlayers) {
      return { success: false, reason: 'Room is full' };
    }

    if (this.players.has(player.id)) {
      return { success: false, reason: 'Player already in room' };
    }

    this.players.set(player.id, player);
    this.network.setRoomId(player.id, this.id);
    this.lastDeltaFrame.set(player.id, 0);
    this.playerAckedFrames.set(player.id, 0);

    const initialPlayerState: PlayerState = {
      id: player.id,
      position: { x: 0, y: 0, z: 0 },
      velocity: { x: 0, y: 0, z: 0 },
      health: 100,
    };
    this.stateSynchronizer.addPlayer(player.id, initialPlayerState);

    const currentState = this.stateSynchronizer.serializeForReconnection();
    this.network.send(player.id, {
      type: MessageType.JOIN_ROOM_ACK,
      timestamp: Date.now(),
      payload: {
        success: true,
        roomId: this.id,
        roomName: this.name,
        playerId: player.id,
        initialState: this.serializeGameStateForClient(currentState.state),
        currentFrame: currentState.baseFrame,
        tickRate: this.config.tickRate,
        players: Array.from(this.players.values()).map(p => ({
          id: p.id,
          sessionId: p.sessionId,
        })),
      },
    });

    this.broadcast({
      type: MessageType.JOIN_ROOM,
      timestamp: Date.now(),
      payload: {
        playerId: player.id,
        sessionId: player.sessionId,
        playerState: initialPlayerState,
      },
    }, player.id);

    console.log(`[Room ${this.id}] Player ${player.id} joined. Total: ${this.players.size}/${this.maxPlayers}`);

    if (this.players.size >= 1 && !this.isRunning) {
      this.start();
    }

    return { success: true };
  }

  removePlayer(playerId: string, reason: string = 'Player left'): void {
    const player = this.players.get(playerId);
    if (!player) return;

    this.players.delete(playerId);
    this.lastDeltaFrame.delete(playerId);
    this.playerAckedFrames.delete(playerId);
    this.network.setRoomId(playerId, null);

    this.stateSynchronizer.removePlayer(playerId);
    this.inputBuffer.removePlayer(playerId);

    this.network.send(playerId, {
      type: MessageType.LEAVE_ROOM,
      timestamp: Date.now(),
      payload: {
        roomId: this.id,
        reason,
      },
    });

    this.broadcast({
      type: MessageType.LEAVE_ROOM,
      timestamp: Date.now(),
      payload: {
        playerId,
        reason,
      },
    });

    console.log(`[Room ${this.id}] Player ${playerId} left. Reason: ${reason}. Remaining: ${this.players.size}`);

    if (this.isEmpty() && this.isRunning) {
      setTimeout(() => {
        if (this.isEmpty()) {
          this.stop();
        }
      }, 5000);
    }
  }

  handleReconnect(playerId: string, sessionId: string, lastKnownFrame: number): { success: boolean; reason?: string } {
    const reconnectEntry = this.reconnectingSessions.get(sessionId);
    if (!reconnectEntry || reconnectEntry.playerId !== playerId) {
      return { success: false, reason: 'Reconnect session not found or expired' };
    }

    clearTimeout(reconnectEntry.timeout);
    this.reconnectingSessions.delete(sessionId);

    const player = this.players.get(playerId);
    if (!player) {
      return { success: false, reason: 'Player not found in room' };
    }

    player.isConnected = true;
    player.lastActivity = Date.now();

    const currentFrame = this.stateSynchronizer.getLatestFrame();
    const baseFrame = Math.max(lastKnownFrame, currentFrame - this.config.maxHistorySnapshots);
    const recoveryState = this.stateSynchronizer.serializeForReconnection();

    this.network.send(playerId, {
      type: MessageType.RECONNECT_ACK,
      timestamp: Date.now(),
      payload: {
        success: true,
        roomId: this.id,
        state: this.serializeGameStateForClient(recoveryState.state),
        baseFrame,
        currentFrame,
        missedFrames: currentFrame - baseFrame,
      },
    });

    console.log(`[Room ${this.id}] Player ${playerId} reconnected. Catching up from frame ${baseFrame} to ${currentFrame}`);
    return { success: true };
  }

  scheduleReconnect(playerId: string, sessionId: string): void {
    const existing = this.reconnectingSessions.get(sessionId);
    if (existing) {
      clearTimeout(existing.timeout);
    }

    const timeout = setTimeout(() => {
      this.reconnectingSessions.delete(sessionId);
      if (!this.players.get(playerId)?.isConnected) {
        this.removePlayer(playerId, 'Reconnect timeout');
      }
    }, this.config.reconnectTimeoutMs);

    this.reconnectingSessions.set(sessionId, { playerId, timeout });
    console.log(`[Room ${this.id}] Scheduled reconnect window for player ${playerId} (${this.config.reconnectTimeoutMs}ms)`);
  }

  processPlayerInput(playerId: string, input: PlayerInput): void {
    if (!this.players.has(playerId)) return;

    this.gameLoop.addPlayerInput(playerId, input.inputData, input.frame);
    
    if (input.frame !== undefined) {
      const currentAck = this.playerAckedFrames.get(playerId) ?? 0;
      if (input.frame > currentAck) {
        this.playerAckedFrames.set(playerId, input.frame);
      }
    }
  }

  private sendFullSnapshots(): void {
    if (this.players.size === 0) return;

    const frame = this.gameLoop.getCurrentFrame();
    if (!this.stateSynchronizer.shouldSendFullSnapshot(frame)) return;

    const snapshot = this.stateSynchronizer.generateFullSnapshot(frame);
    const serialized = this.serializeGameStateForClient(snapshot);

    for (const [playerId] of this.players) {
      this.network.send(playerId, {
        type: MessageType.STATE_FULL,
        timestamp: Date.now(),
        payload: {
          frame,
          state: serialized,
        },
      });
      this.lastDeltaFrame.set(playerId, frame);
    }
  }

  private sendDeltaUpdates(): void {
    if (this.players.size === 0) return;

    const currentFrame = this.gameLoop.getCurrentFrame();

    for (const [playerId] of this.players) {
      const baseFrame = this.lastDeltaFrame.get(playerId) ?? Math.max(0, currentFrame - 10);
      
      if (baseFrame >= currentFrame) continue;

      const delta = this.stateSynchronizer.generateDelta(baseFrame, currentFrame);
      if (!delta) continue;

      const serializedDelta = {
        ...delta,
        playerUpdates: this.serializePlayerUpdates(delta.playerUpdates),
      };

      this.network.send(playerId, {
        type: MessageType.STATE_DELTA,
        timestamp: Date.now(),
        payload: serializedDelta,
      });

      this.lastDeltaFrame.set(playerId, currentFrame);
    }
  }

  private checkAndSendCorrections(currentFrame: number): void {
    for (const [playerId, player] of this.players) {
      const ackedFrame = this.playerAckedFrames.get(playerId) ?? 0;
      if (ackedFrame <= 0) continue;

      const historySnapshot = this.stateSynchronizer.getHistorySnapshot(ackedFrame);
      if (!historySnapshot) continue;

      const serverPlayerState = historySnapshot.state.players.get(playerId);
      if (!serverPlayerState) continue;

      const clientEstimatedFrame = this.lagCompensation.estimateServerFrameFromClient(
        ackedFrame,
        player.rtt,
        currentFrame
      );

      if (Math.abs(currentFrame - clientEstimatedFrame) > 30) {
        const correction = this.lagCompensation.generateCorrectionPayload(
          playerId,
          currentFrame,
          serverPlayerState,
          ackedFrame
        );

        this.network.send(playerId, {
          type: MessageType.CORRECTION,
          timestamp: Date.now(),
          payload: correction,
        });
      }
    }
  }

  private serializeGameStateForClient(state: GameState): unknown {
    return {
      frame: state.frame,
      timestamp: state.timestamp,
      players: Array.from(state.players.entries()).map(([id, player]) => {
        const { id: _playerId, ...playerWithoutId } = player as PlayerState & { id: string };
        void _playerId;
        return {
          id,
          ...playerWithoutId,
        };
      }),
      worldState: state.worldState,
    };
  }

  private serializePlayerUpdates(updates: Map<string, Partial<PlayerState>>): unknown {
    return Array.from(updates.entries()).map(([id, partial]) => ({
      id,
      ...partial,
    }));
  }

  broadcast<T>(message: Omit<NetworkMessage<T>, 'seq'>, excludePlayerId?: string): void {
    const playerIds = Array.from(this.players.keys());
    this.network.broadcast(playerIds, message, excludePlayerId);
  }

  isEmpty(): boolean {
    return this.players.size === 0;
  }

  isFull(): boolean {
    return this.players.size >= this.maxPlayers;
  }

  getPlayerCount(): number {
    return this.players.size;
  }

  getPlayer(playerId: string): PlayerConnection | undefined {
    return this.players.get(playerId);
  }

  getAllPlayers(): PlayerConnection[] {
    return Array.from(this.players.values());
  }

  getCurrentFrame(): number {
    return this.gameLoop.getCurrentFrame();
  }

  getStats(): unknown {
    return {
      id: this.id,
      name: this.name,
      playerCount: this.players.size,
      maxPlayers: this.maxPlayers,
      isRunning: this.isRunning,
      isPrivate: this.isPrivate,
      gameMode: this.gameMode,
      currentFrame: this.getCurrentFrame(),
      createdAt: this.createdAt,
      gameLoopStats: this.gameLoop.getStats(),
    };
  }
}

export class RoomManager extends EventEmitter {
  private rooms: Map<string, Room> = new Map();
  private playerToRoom: Map<string, string> = new Map();
  private sessionToPlayer: Map<string, string> = new Map();
  private network: NetworkLayer;
  private config: ServerConfig;

  constructor(network: NetworkLayer, config: ServerConfig) {
    super();
    this.network = network;
    this.config = config;
    this.setupNetworkHandlers();
  }

  private setupNetworkHandlers(): void {
    this.network.on('connection', (player: PlayerConnection) => {
      this.sessionToPlayer.set(player.sessionId, player.id);
    });

    this.network.on('disconnection', (player: PlayerConnection) => {
      const roomId = this.playerToRoom.get(player.id);
      if (roomId) {
        const room = this.rooms.get(roomId);
        if (room) {
          room.scheduleReconnect(player.id, player.sessionId);
        }
      }
    });

    this.network.on('message', (player: PlayerConnection, message: NetworkMessage) => {
      this.handleNetworkMessage(player, message);
    });

    this.network.on('reconnect', (player: PlayerConnection, payload: unknown) => {
      this.handleReconnect(player, payload as { sessionId: string; lastFrame: number });
    });
  }

  private handleNetworkMessage(player: PlayerConnection, message: NetworkMessage): void {
    const roomId = this.playerToRoom.get(player.id);

    switch (message.type) {
      case MessageType.JOIN_ROOM:
        this.handleJoinRoom(player, message.payload as { roomId?: string; roomName?: string; createIfNotExists?: boolean });
        break;
      case MessageType.LEAVE_ROOM:
        if (roomId) {
          this.leaveRoom(player.id);
        }
        break;
      case MessageType.PLAYER_INPUT:
        if (roomId) {
          const room = this.rooms.get(roomId);
          if (room) {
            const inputPayload = message.payload as PlayerInput;
            room.processPlayerInput(player.id, {
              ...inputPayload,
              playerId: player.id,
            });
          }
        }
        break;
    }
  }

  private handleJoinRoom(
    player: PlayerConnection,
    payload: { roomId?: string; roomName?: string; createIfNotExists?: boolean; gameMode?: string; maxPlayers?: number }
  ): void {
    if (this.playerToRoom.has(player.id)) {
      this.network.sendError(player.id, 'Player already in a room');
      return;
    }

    let room: Room | undefined;

    if (payload.roomId) {
      room = this.rooms.get(payload.roomId);
    }

    if (!room && payload.createIfNotExists !== false) {
      room = this.findOrCreateRoom({
        name: payload.roomName,
        gameMode: payload.gameMode,
        maxPlayers: payload.maxPlayers,
      });
    }

    if (!room) {
      this.network.sendError(player.id, 'Room not found');
      return;
    }

    const result = room.addPlayer(player);
    if (!result.success) {
      this.network.sendError(player.id, result.reason ?? 'Failed to join room');
      return;
    }

    this.playerToRoom.set(player.id, room.id);
    this.emit('player-joined', { roomId: room.id, playerId: player.id });
  }

  private handleReconnect(
    player: PlayerConnection,
    payload: { sessionId: string; lastFrame: number }
  ): void {
    const originalPlayerId = this.sessionToPlayer.get(payload.sessionId);
    if (!originalPlayerId) {
      this.network.sendError(player.id, 'Invalid reconnect session');
      return;
    }

    const roomId = this.playerToRoom.get(originalPlayerId);
    if (!roomId) {
      this.network.sendError(player.id, 'No room to reconnect to');
      return;
    }

    const room = this.rooms.get(roomId);
    if (!room) {
      this.network.sendError(player.id, 'Room no longer exists');
      return;
    }

    const existingPlayer = room.getPlayer(originalPlayerId);
    if (!existingPlayer || existingPlayer.sessionId !== payload.sessionId) {
      this.network.sendError(player.id, 'Reconnect validation failed');
      return;
    }

    existingPlayer.id = player.id;
    this.sessionToPlayer.set(player.sessionId, player.id);
    this.playerToRoom.set(player.id, roomId);
    this.playerToRoom.delete(originalPlayerId);

    const result = room.handleReconnect(player.id, payload.sessionId, payload.lastFrame);
    if (!result.success) {
      this.network.sendError(player.id, result.reason ?? 'Reconnect failed');
    }
  }

  findOrCreateRoom(options: RoomOptions = {}): Room {
    let room: Room | undefined;

    if (!options.isPrivate) {
      room = Array.from(this.rooms.values()).find(
        (r) => !r.isFull() && !r.isPrivate && 
               (options.gameMode ? r.gameMode === options.gameMode : true)
      );
    }

    if (!room) {
      if (this.rooms.size >= this.config.maxRooms) {
        throw new Error('Maximum number of rooms reached');
      }
      room = this.createRoom(options);
    }

    return room;
  }

  createRoom(options: RoomOptions = {}): Room {
    if (this.rooms.size >= this.config.maxRooms) {
      throw new Error('Maximum number of rooms reached');
    }

    const room = new Room(options, this.network, this.config);
    this.rooms.set(room.id, room);

    console.log(`[RoomManager] Created room ${room.id} (${room.name}). Total rooms: ${this.rooms.size}`);
    this.emit('room-created', room.id);

    return room;
  }

  deleteRoom(roomId: string): boolean {
    const room = this.rooms.get(roomId);
    if (!room) return false;

    room.stop();

    for (const playerId of room.getAllPlayers().map(p => p.id)) {
      this.playerToRoom.delete(playerId);
    }

    this.rooms.delete(roomId);
    this.emit('room-deleted', roomId);
    console.log(`[RoomManager] Deleted room ${roomId}. Total rooms: ${this.rooms.size}`);
    return true;
  }

  leaveRoom(playerId: string): boolean {
    const roomId = this.playerToRoom.get(playerId);
    if (!roomId) return false;

    const room = this.rooms.get(roomId);
    if (!room) {
      this.playerToRoom.delete(playerId);
      return false;
    }

    room.removePlayer(playerId);
    this.playerToRoom.delete(playerId);
    this.emit('player-left', { roomId, playerId });

    if (room.isEmpty()) {
      setTimeout(() => {
        if (room.isEmpty()) {
          this.deleteRoom(roomId);
        }
      }, 30000);
    }

    return true;
  }

  getRoom(roomId: string): Room | undefined {
    return this.rooms.get(roomId);
  }

  getRoomForPlayer(playerId: string): Room | undefined {
    const roomId = this.playerToRoom.get(playerId);
    return roomId ? this.rooms.get(roomId) : undefined;
  }

  listRooms(includePrivate = false): Array<{ id: string; name: string; playerCount: number; maxPlayers: number; gameMode: string; isPrivate: boolean }> {
    return Array.from(this.rooms.values())
      .filter((r) => includePrivate || !r.isPrivate)
      .map((r) => ({
        id: r.id,
        name: r.name,
        playerCount: r.getPlayerCount(),
        maxPlayers: r.maxPlayers,
        gameMode: r.gameMode,
        isPrivate: r.isPrivate,
      }));
  }

  getRoomCount(): number {
    return this.rooms.size;
  }

  getTotalPlayers(): number {
    return this.playerToRoom.size;
  }

  shutdown(): void {
    console.log('[RoomManager] Shutting down...');
    for (const roomId of Array.from(this.rooms.keys())) {
      this.deleteRoom(roomId);
    }
    this.playerToRoom.clear();
    this.sessionToPlayer.clear();
    console.log('[RoomManager] Shutdown complete');
  }
}
