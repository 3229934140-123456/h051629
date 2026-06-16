import { WebSocketServer, WebSocket, RawData } from 'ws';
import * as msgpack from 'msgpack-lite';
import { v4 as uuidv4 } from 'uuid';
import { EventEmitter } from 'events';
import {
  MessageType,
  NetworkMessage,
  PlayerConnection,
  ServerConfig,
} from '../types';

interface PendingMessage {
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
  timeout: NodeJS.Timeout;
}

export class NetworkLayer extends EventEmitter {
  private wss: WebSocketServer;
  private config: ServerConfig;
  private connections: Map<string, { ws: WebSocket; conn: PlayerConnection }> = new Map();
  private pendingMessages: Map<string, Map<number, PendingMessage>> = new Map();
  private heartbeatTimers: Map<string, NodeJS.Timeout> = new Map();

  constructor(config: ServerConfig) {
    super();
    this.config = config;
    this.wss = new WebSocketServer({ port: config.port });
    this.setupServerHandlers();
    console.log(`[NetworkLayer] WebSocket server started on port ${config.port}`);
  }

  private setupServerHandlers(): void {
    this.wss.on('connection', (ws, request) => {
      this.handleConnection(ws, request);
    });

    this.wss.on('error', (error) => {
      console.error('[NetworkLayer] Server error:', error);
      this.emit('error', error);
    });
  }

  private handleConnection(ws: WebSocket, _request: unknown): void {
    const connectionId = uuidv4();
    const sessionId = uuidv4();

    const playerConn: PlayerConnection = {
      id: connectionId,
      sessionId,
      roomId: null,
      isConnected: true,
      joinedAt: Date.now(),
      lastActivity: Date.now(),
      rtt: 0,
      lastReceivedSeq: 0,
      lastSentSeq: 0,
    };

    this.connections.set(connectionId, { ws, conn: playerConn });
    this.pendingMessages.set(connectionId, new Map());

    this.setupConnectionHandlers(connectionId, ws, playerConn);
    this.startHeartbeat(connectionId);

    this.send(connectionId, {
      type: MessageType.HANDSHAKE,
      timestamp: Date.now(),
      payload: {
        connectionId,
        sessionId,
        serverTime: Date.now(),
        tickRate: this.config.tickRate,
      },
    });

    this.emit('connection', playerConn);
    console.log(`[NetworkLayer] Client connected: ${connectionId}`);
  }

  private setupConnectionHandlers(
    connectionId: string,
    ws: WebSocket,
    conn: PlayerConnection
  ): void {
    ws.on('message', (data) => {
      this.handleMessage(connectionId, data, conn);
    });

    ws.on('close', (code, reason) => {
      this.handleDisconnection(connectionId, code, reason.toString());
    });

    ws.on('error', (error) => {
      console.error(`[NetworkLayer] Connection error ${connectionId}:`, error);
    });
  }

  private handleMessage(
    connectionId: string,
    data: RawData,
    conn: PlayerConnection
  ): void {
    try {
      const message = this.deserialize(data) as NetworkMessage;
      conn.lastActivity = Date.now();

      if (message.seq !== undefined && message.seq > conn.lastReceivedSeq) {
        conn.lastReceivedSeq = message.seq;
      }

      switch (message.type) {
        case MessageType.HANDSHAKE_ACK:
          this.handleHandshakeAck(connectionId, message);
          break;
        case MessageType.PING:
          this.handlePing(connectionId, message);
          break;
        case MessageType.PONG:
          this.handlePong(connectionId, message);
          break;
        case MessageType.RECONNECT:
          this.emit('reconnect', conn, message.payload);
          break;
        default:
          if (message.seq !== undefined) {
            const pending = this.pendingMessages.get(connectionId);
            if (pending && pending.has(message.seq)) {
              const pm = pending.get(message.seq)!;
              clearTimeout(pm.timeout);
              pm.resolve(message.payload);
              pending.delete(message.seq);
            }
          }
          this.emit('message', conn, message);
          break;
      }
    } catch (error) {
      console.error(`[NetworkLayer] Failed to process message from ${connectionId}:`, error);
      this.sendError(connectionId, 'Invalid message format');
    }
  }

  private handleHandshakeAck(connectionId: string, message: NetworkMessage): void {
    const { ws } = this.connections.get(connectionId)!;
    const rtt = Date.now() - message.timestamp;
    const conn = this.connections.get(connectionId)!.conn;
    conn.rtt = rtt;

    this.send(connectionId, {
      type: MessageType.HANDSHAKE_ACK,
      timestamp: Date.now(),
      payload: {
        success: true,
        rtt,
      },
    });

    console.log(`[NetworkLayer] Handshake complete with ${connectionId}, RTT: ${rtt}ms`);
    this.emit('handshake-complete', conn);
    void ws;
  }

  private handlePing(connectionId: string, message: NetworkMessage): void {
    this.send(connectionId, {
      type: MessageType.PONG,
      timestamp: Date.now(),
      payload: {
        clientTimestamp: message.timestamp,
        serverTimestamp: Date.now(),
      },
    });
  }

  private handlePong(connectionId: string, message: NetworkMessage): void {
    const { clientTimestamp } = message.payload as { clientTimestamp: number };
    const rtt = Date.now() - clientTimestamp;
    const conn = this.connections.get(connectionId)?.conn;
    if (conn) {
      conn.rtt = rtt;
    }
  }

  private handleDisconnection(connectionId: string, code: number, reason: string): void {
    const conn = this.connections.get(connectionId)?.conn;
    
    this.stopHeartbeat(connectionId);
    
    const pending = this.pendingMessages.get(connectionId);
    if (pending) {
      pending.forEach((pm) => {
        clearTimeout(pm.timeout);
        pm.reject(new Error('Connection closed'));
      });
      this.pendingMessages.delete(connectionId);
    }

    this.connections.delete(connectionId);

    if (conn) {
      conn.isConnected = false;
      this.emit('disconnection', conn, { code, reason });
    }

    console.log(`[NetworkLayer] Client disconnected: ${connectionId}, code: ${code}, reason: ${reason}`);
  }

  private startHeartbeat(connectionId: string): void {
    const timer = setInterval(() => {
      const entry = this.connections.get(connectionId);
      if (!entry) {
        this.stopHeartbeat(connectionId);
        return;
      }

      if (Date.now() - entry.conn.lastActivity > this.config.reconnectTimeoutMs) {
        console.log(`[NetworkLayer] Heartbeat timeout for ${connectionId}, closing...`);
        entry.ws.close(4000, 'Heartbeat timeout');
        return;
      }

      this.send(connectionId, {
        type: MessageType.PING,
        timestamp: Date.now(),
        payload: {},
      });
    }, 10000);

    this.heartbeatTimers.set(connectionId, timer);
  }

  private stopHeartbeat(connectionId: string): void {
    const timer = this.heartbeatTimers.get(connectionId);
    if (timer) {
      clearInterval(timer);
      this.heartbeatTimers.delete(connectionId);
    }
  }

  send<T = unknown>(
    connectionId: string,
    message: Omit<NetworkMessage<T>, 'seq'>,
    requireAck = false,
    ackTimeout = 5000
  ): Promise<unknown> | void {
    const entry = this.connections.get(connectionId);
    if (!entry || entry.ws.readyState !== WebSocket.OPEN) {
      if (requireAck) {
        return Promise.reject(new Error('Connection not available'));
      }
      return;
    }

    entry.conn.lastSentSeq++;
    const fullMessage: NetworkMessage<T> = {
      ...message,
      seq: entry.conn.lastSentSeq,
    };

    const serialized = this.serialize(fullMessage);
    entry.ws.send(serialized, (error) => {
      if (error) {
        console.error(`[NetworkLayer] Send error to ${connectionId}:`, error);
      }
    });

    if (requireAck) {
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          const pending = this.pendingMessages.get(connectionId);
          if (pending) {
            pending.delete(fullMessage.seq!);
          }
          reject(new Error('ACK timeout'));
        }, ackTimeout);

        let pending = this.pendingMessages.get(connectionId);
        if (!pending) {
          pending = new Map();
          this.pendingMessages.set(connectionId, pending);
        }
        pending.set(fullMessage.seq!, { resolve, reject, timeout });
      });
    }
  }

  broadcast<T = unknown>(
    connectionIds: string[],
    message: Omit<NetworkMessage<T>, 'seq'>,
    excludeId?: string
  ): void {
    for (const id of connectionIds) {
      if (id !== excludeId) {
        this.send(id, message);
      }
    }
  }

  getConnection(connectionId: string): PlayerConnection | undefined {
    return this.connections.get(connectionId)?.conn;
  }

  setRoomId(connectionId: string, roomId: string | null): void {
    const entry = this.connections.get(connectionId);
    if (entry) {
      entry.conn.roomId = roomId;
    }
  }

  serialize<T>(message: NetworkMessage<T>): Buffer {
    return msgpack.encode(message) as Buffer;
  }

  deserialize(data: RawData): NetworkMessage {
    const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
    return msgpack.decode(buffer) as NetworkMessage;
  }

  sendError(connectionId: string, errorMessage: string): void {
    this.send(connectionId, {
      type: MessageType.ERROR,
      timestamp: Date.now(),
      payload: { message: errorMessage },
    });
  }

  getConnectionCount(): number {
    return this.connections.size;
  }

  close(): void {
    this.heartbeatTimers.forEach((timer) => clearInterval(timer));
    this.heartbeatTimers.clear();

    this.connections.forEach(({ ws, conn }) => {
      ws.close(1001, 'Server shutting down');
      void conn;
    });
    this.connections.clear();
    this.wss.close();
    console.log('[NetworkLayer] Server closed');
  }
}
