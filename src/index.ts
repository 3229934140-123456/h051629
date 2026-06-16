import { ServerConfig, DEFAULT_CONFIG } from './types';
import { NetworkLayer } from './network/NetworkLayer';
import { RoomManager } from './room/RoomManager';

export class GameServer {
  private config: ServerConfig;
  private network: NetworkLayer;
  private roomManager: RoomManager;
  private isRunning = false;
  private statsTimer: NodeJS.Timeout | null = null;

  constructor(customConfig?: Partial<ServerConfig>) {
    this.config = {
      ...DEFAULT_CONFIG,
      ...customConfig,
    };

    this.network = new NetworkLayer(this.config);
    this.roomManager = new RoomManager(this.network, this.config);

    this.setupShutdownHandlers();
  }

  private setupShutdownHandlers(): void {
    const shutdown = (signal: string) => {
      console.log(`\n[GameServer] Received ${signal}, shutting down gracefully...`);
      this.shutdown();
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('uncaughtException', (error) => {
      console.error('[GameServer] Uncaught exception:', error);
    });
    process.on('unhandledRejection', (reason) => {
      console.error('[GameServer] Unhandled rejection:', reason);
    });
  }

  start(): void {
    if (this.isRunning) return;

    this.isRunning = true;
    this.startStatsReporting();

    console.log('========================================');
    console.log('    Game Server Framework Started');
    console.log('========================================');
    console.log(`  Port:              ${this.config.port}`);
    console.log(`  Tick Rate:         ${this.config.tickRate}Hz`);
    console.log(`  Max Rooms:         ${this.config.maxRooms}`);
    console.log(`  Max Players/Room:  ${this.config.maxPlayersPerRoom}`);
    console.log(`  Snapshot Interval: ${this.config.snapshotInterval}ms`);
    console.log(`  Delta Interval:    ${this.config.deltaSyncInterval}ms`);
    console.log('========================================');
    console.log();
    console.log('Available commands:');
    console.log('  status                             - Show server statistics');
    console.log('  rooms                              - List all active rooms');
    console.log('  players                            - List all connected players');
    console.log('  room <roomId>                      - Show detailed debug status for a room');
    console.log('  events <roomId> [--admin|--player] - Show room event audit log');
    console.log('  pause <roomId>                     - Pause game loop for a room');
    console.log('  resume <roomId>                    - Resume game loop for a room');
    console.log('  kick <roomId> <playerId>           - Kick a player from room');
    console.log('  lock <roomId>                      - Lock room (no new players)');
    console.log('  unlock <roomId>                    - Unlock room');
    console.log('  announce <roomId> [--players|--spectators] <text>  - Send system announcement');
    console.log('  shutdown                           - Gracefully shutdown the server');
    console.log();
  }

  private startStatsReporting(): void {
    this.statsTimer = setInterval(() => {
      this.printStats();
    }, 30000);
  }

  private printStats(): void {
    const roomCount = this.roomManager.getRoomCount();
    const totalPlayers = this.roomManager.getTotalPlayers();
    const connections = this.network.getConnectionCount();

    console.log(`\n[Server Stats] ${new Date().toISOString()}`);
    console.log(`  Rooms:       ${roomCount}/${this.config.maxRooms}`);
    console.log(`  Players:     ${totalPlayers}`);
    console.log(`  Connections: ${connections}`);
    console.log();
  }

  getRoomManager(): RoomManager {
    return this.roomManager;
  }

  getNetwork(): NetworkLayer {
    return this.network;
  }

  getConfig(): ServerConfig {
    return { ...this.config };
  }

  shutdown(): void {
    if (!this.isRunning) return;

    this.isRunning = false;

    if (this.statsTimer) {
      clearInterval(this.statsTimer);
      this.statsTimer = null;
    }

    this.roomManager.shutdown();
    this.network.close();

    console.log('[GameServer] Server shutdown complete');
    process.exit(0);
  }
}

export * from './types';
export { NetworkLayer } from './network/NetworkLayer';
export { RoomManager } from './room/RoomManager';
export { InputBuffer } from './input/InputBuffer';
export { StateSynchronizer } from './sync/StateSynchronizer';
export { LagCompensation } from './sync/LagCompensation';
export { GameLoop } from './loop/GameLoop';

if (require.main === module) {
  const server = new GameServer({
    port: parseInt(process.env.PORT || '8080', 10),
    tickRate: parseInt(process.env.TICK_RATE || '60', 10),
  });

  server.start();

  if (process.stdin.isTTY) {
    const readline = require('readline');
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    rl.setPrompt('> ');
    rl.prompt();

    rl.on('line', (line: string) => {
      const trimmed = line.trim();
      const parts = trimmed.split(/\s+/);
      const command = parts[0].toLowerCase();
      const args = parts.slice(1);

      switch (command) {
        case 'status':
          server['printStats']();
          break;
        case 'rooms':
          console.log('\n[Active Rooms]');
          const rooms = server.getRoomManager().listRooms(true);
          if (rooms.length === 0) {
            console.log('  No active rooms');
          } else {
            rooms.forEach((room, index) => {
              console.log(`  ${index + 1}. ${room.name} (${room.id})`);
              console.log(`     Players: ${room.playerCount}/${room.maxPlayers}, Mode: ${room.gameMode}, Private: ${room.isPrivate}`);
            });
          }
          console.log();
          break;
        case 'players':
          console.log('\n[Connected Players by Room]');
          const allRooms = server.getRoomManager().listRooms(true);
          let total = 0;
          for (const roomInfo of allRooms) {
            const room = server.getRoomManager().getRoom(roomInfo.id);
            if (room) {
              const players = room.getAllPlayers();
              total += players.length;
              console.log(`  Room: ${roomInfo.name}`);
              players.forEach((p) => {
                console.log(`    - ${p.id} (Connected: ${p.isConnected}, RTT: ${p.rtt}ms)`);
              });
            }
          }
          if (total === 0) {
            console.log('  No players connected');
          }
          console.log();
          break;
        case 'room': {
          if (args.length === 0) {
            console.log('Usage: room <roomId>');
            break;
          }
          const roomId = args[0];
          const room = server.getRoomManager().getRoom(roomId);
          if (!room) {
            console.log(`Room not found: ${roomId}`);
            break;
          }
          const status = room.getDebugStatus() as {
            roomId: string;
            roomName: string;
            isRunning: boolean;
            isPaused: boolean;
            pauseReason: string | null;
            pausedAt: number | null;
            isLocked: boolean;
            lockReason: string | null;
            lockedAt: number | null;
            currentFrame: number;
            createdAt: number;
            onlinePlayers: Array<{ id: string; sessionId: string; rtt: number }>;
            reconnectingPlayers: Array<{
              sessionId: string;
              playerId: string;
              timeoutRemainingMs: number;
              elapsedMs: number;
              totalMs: number;
              status: string;
              disconnectedAt: number;
            }>;
            spectators: Array<{ id: string; sessionId: string }>;
            spectatorCount: number;
            reconnectingCount: number;
            playerCount: number;
            maxPlayers: number;
            hasEmptyRoomDestroyTimer: boolean;
            emptyRoomDestroyRemainingMs: number | null;
            gameLoopStats: unknown;
            lastAnnouncement: { text: string; timestamp: number; target: string; senderId?: string } | null;
            recentEvents?: Array<{ id: string; type: string; category: string; timestamp: number; frame: number; actorId?: string; actorType?: string; data: Record<string, unknown> }>;
          };
          console.log(`\n[Room Debug Status] ${status.roomName}`);
          console.log(`  Room ID:        ${status.roomId}`);
          console.log(`  Running:        ${status.isRunning}`);
          console.log(`  Paused:         ${status.isPaused}${status.pauseReason ? ` (${status.pauseReason})` : ''}`);
          console.log(`  Locked:         ${status.isLocked}${status.lockReason ? ` (${status.lockReason})` : ''}`);
          console.log(`  Current Frame:  ${status.currentFrame}`);
          console.log(`  Created At:     ${new Date(status.createdAt).toISOString()}`);
          console.log(`  Players:        ${status.playerCount}/${status.maxPlayers} (connected)`);
          console.log(`  Reconnecting:   ${status.reconnectingCount}`);
          console.log(`  Spectators:     ${status.spectatorCount}`);
          if (status.hasEmptyRoomDestroyTimer) {
            console.log(`  Destroy Timer:  ${status.emptyRoomDestroyRemainingMs}ms remaining`);
          }
          if (status.lastAnnouncement) {
            const ann = status.lastAnnouncement;
            console.log(`  Last Announce:   [${ann.target}] ${ann.text} (${new Date(ann.timestamp).toLocaleTimeString()})`);
          }
          console.log();
          console.log('  [Online Players]');
          if (status.onlinePlayers.length === 0) {
            console.log('    (none)');
          } else {
            status.onlinePlayers.forEach((p) => {
              console.log(`    - ${p.id.substring(0, 16)}..., RTT=${p.rtt}ms`);
              console.log(`      Session: ${p.sessionId.substring(0, 16)}...`);
            });
          }
          console.log();
          console.log('  [Reconnecting Players]');
          if (status.reconnectingPlayers.length === 0) {
            console.log('    (none)');
          } else {
            const statusLabels: Record<string, string> = {
              fresh: '刚掉线',
              normal: '正常',
              warning: '快超时',
              expired: '已超时',
            };
            status.reconnectingPlayers.forEach((rp) => {
              const label = statusLabels[rp.status] ?? rp.status;
              console.log(`    - [${label}] ${rp.playerId.substring(0, 16)}...`);
              console.log(`      Remaining: ${rp.timeoutRemainingMs}ms / ${rp.totalMs}ms (${rp.elapsedMs}ms elapsed)`);
              console.log(`      Session: ${rp.sessionId.substring(0, 16)}...`);
              console.log(`      Disconnected: ${new Date(rp.disconnectedAt).toLocaleTimeString()}`);
            });
          }
          console.log();
          console.log('  [Spectators]');
          if (status.spectators.length === 0) {
            console.log('    (none)');
          } else {
            status.spectators.forEach((s) => {
              console.log(`    - ${s.id.substring(0, 16)}...`);
              console.log(`      Session: ${s.sessionId.substring(0, 16)}...`);
            });
          }
          console.log();
          console.log('  [Recent Events]');
          if (!status.recentEvents || status.recentEvents.length === 0) {
            console.log('    (none)');
          } else {
            status.recentEvents.forEach((e) => {
              const timeStr = new Date(e.timestamp).toLocaleTimeString();
              const actorTag = e.actorId ? ` [by ${e.actorType}:${e.actorId.substring(0, 8)}]` : '';
              console.log(`    [${timeStr}] ${e.category.toUpperCase()} ${e.type}${actorTag}`);
              console.log(`      Frame: ${e.frame}, Data: ${JSON.stringify(e.data)}`);
            });
          }
          console.log();
          console.log('  [GameLoop Stats]');
          console.log(`    ${JSON.stringify(status.gameLoopStats, null, 6).split('\n').join('\n    ')}`);
          console.log();
          break;
        }
        case 'events': {
          if (args.length === 0) {
            console.log('Usage: events <roomId> [--admin] [--player] [--spectator] [--system] [--limit N]');
            break;
          }
          const roomId = args[0];
          const room = server.getRoomManager().getRoom(roomId);
          if (!room) {
            console.log(`Room not found: ${roomId}`);
            break;
          }
          const flags = args.slice(1).filter(a => a.startsWith('--'));
          const limitArg = args.find(a => a.startsWith('--limit='));
          const limit = limitArg ? parseInt(limitArg.split('=')[1], 10) : 30;
          const categories: string[] = [];
          if (flags.includes('--admin')) categories.push('admin');
          if (flags.includes('--player')) categories.push('player');
          if (flags.includes('--spectator')) categories.push('spectator');
          if (flags.includes('--system')) categories.push('system');

          const events = (room as unknown as {
            queryEvents: (opts: { categories?: string[]; limit?: number }) => Array<{
              id: string; type: string; category: string; timestamp: number;
              frame: number; actorId?: string; actorType?: string; data: Record<string, unknown>;
            }>;
          }).queryEvents({ categories: categories.length > 0 ? categories : undefined, limit });

          console.log(`\n[Room Event Log] ${roomId} (${events.length} events)`);
          if (events.length === 0) {
            console.log('  (no events)');
          } else {
            events.forEach((e) => {
              const timeStr = new Date(e.timestamp).toLocaleTimeString();
              const actorTag = e.actorId ? ` [by ${e.actorType}:${e.actorId.substring(0, 8)}]` : '';
              console.log(`  [${timeStr}] ${e.category.toUpperCase().padEnd(9)} ${e.type}${actorTag}`);
              console.log(`    Frame: ${e.frame}, Data: ${JSON.stringify(e.data)}`);
            });
          }
          console.log();
          break;
        }
        case 'pause': {
          if (args.length === 0) {
            console.log('Usage: pause <roomId> [reason]');
            break;
          }
          const roomId = args[0];
          const reason = args.slice(1).join(' ') || 'Admin paused via console';
          const room = server.getRoomManager().getRoom(roomId);
          if (!room) {
            console.log(`Room not found: ${roomId}`);
            break;
          }
          const ok = room.pause(reason, 'console', 'admin');
          console.log(ok ? `Room ${roomId} paused successfully` : `Failed to pause room ${roomId} (not running?)`);
          break;
        }
        case 'resume': {
          if (args.length === 0) {
            console.log('Usage: resume <roomId>');
            break;
          }
          const roomId = args[0];
          const room = server.getRoomManager().getRoom(roomId);
          if (!room) {
            console.log(`Room not found: ${roomId}`);
            break;
          }
          const ok = room.resume('console', 'admin');
          console.log(ok ? `Room ${roomId} resumed successfully` : `Failed to resume room ${roomId} (not running or not paused?)`);
          break;
        }
        case 'kick': {
          if (args.length < 2) {
            console.log('Usage: kick <roomId> <playerId> [reason]');
            break;
          }
          const roomId = args[0];
          const playerId = args[1];
          const reason = args.slice(2).join(' ') || 'Kicked by admin';
          const room = server.getRoomManager().getRoom(roomId);
          if (!room) {
            console.log(`Room not found: ${roomId}`);
            break;
          }
          const ok = room.kickPlayer(playerId, reason, 'console', 'admin');
          if (ok) {
            server.getRoomManager()['playerToRoom'].delete(playerId);
            console.log(`Player ${playerId} kicked from room ${roomId}`);
          } else {
            console.log(`Failed to kick player ${playerId} (not found?)`);
          }
          break;
        }
        case 'lock': {
          if (args.length === 0) {
            console.log('Usage: lock <roomId> [reason]');
            break;
          }
          const roomId = args[0];
          const reason = args.slice(1).join(' ') || 'Admin locked';
          const room = server.getRoomManager().getRoom(roomId);
          if (!room) {
            console.log(`Room not found: ${roomId}`);
            break;
          }
          const ok = room.lock(reason, 'console', 'admin');
          console.log(ok ? `Room ${roomId} locked successfully` : `Failed to lock room ${roomId} (already locked?)`);
          break;
        }
        case 'unlock': {
          if (args.length === 0) {
            console.log('Usage: unlock <roomId>');
            break;
          }
          const roomId = args[0];
          const room = server.getRoomManager().getRoom(roomId);
          if (!room) {
            console.log(`Room not found: ${roomId}`);
            break;
          }
          const ok = room.unlock('console', 'admin');
          console.log(ok ? `Room ${roomId} unlocked successfully` : `Failed to unlock room ${roomId} (not locked?)`);
          break;
        }
        case 'announce': {
          if (args.length < 2) {
            console.log('Usage: announce <roomId> [--players|--spectators] <text>');
            break;
          }
          const roomId = args[0];
          let target = 'all';
          let textStartIdx = 1;
          if (args[1] === '--players') { target = 'players_only'; textStartIdx = 2; }
          else if (args[1] === '--spectators') { target = 'spectators_only'; textStartIdx = 2; }
          const text = args.slice(textStartIdx).join(' ');
          if (!text) {
            console.log('Announcement text cannot be empty');
            break;
          }
          const room = server.getRoomManager().getRoom(roomId);
          if (!room) {
            console.log(`Room not found: ${roomId}`);
            break;
          }
          (room as unknown as {
            sendSystemAnnouncement: (t: string, target: string, s: string, st: string) => void;
          }).sendSystemAnnouncement(text, target, 'console', 'admin');
          console.log(`Announcement sent to room ${roomId} [${target}]: ${text}`);
          break;
        }
        case 'shutdown':
        case 'quit':
        case 'exit':
          server.shutdown();
          break;
        case 'help':
          console.log('\nAvailable commands:');
          console.log('  status                             - Show server statistics');
          console.log('  rooms                              - List all active rooms');
          console.log('  players                            - List all connected players');
          console.log('  room <roomId>                      - Show detailed debug status for a room');
          console.log('  events <roomId> [--admin|--player] - Show room event audit log');
          console.log('  pause <roomId>                     - Pause game loop for a room');
          console.log('  resume <roomId>                    - Resume game loop for a room');
          console.log('  kick <roomId> <playerId>           - Kick a player from room');
          console.log('  lock <roomId>                      - Lock room (no new players)');
          console.log('  unlock <roomId>                    - Unlock room');
          console.log('  announce <roomId> [--players|--spectators] <text>  - Send system announcement');
          console.log('  shutdown                           - Gracefully shutdown the server');
          console.log('  help                               - Show this help message');
          console.log();
          break;
        case '':
          break;
        default:
          console.log(`Unknown command: ${command}. Type 'help' for available commands.`);
      }

      rl.prompt();
    });

    rl.on('close', () => {
      server.shutdown();
    });
  }
}
