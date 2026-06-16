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
    console.log('  status    - Show server statistics');
    console.log('  rooms     - List all active rooms');
    console.log('  players   - List all connected players');
    console.log('  shutdown  - Gracefully shutdown the server');
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
      const command = line.trim().toLowerCase();

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
              console.log(`  ${index + 1}. ${room.name} (${room.id.substring(0, 8)}...)`);
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
                console.log(`    - ${p.id.substring(0, 8)}... (Connected: ${p.isConnected}, RTT: ${p.rtt}ms)`);
              });
            }
          }
          if (total === 0) {
            console.log('  No players connected');
          }
          console.log();
          break;
        case 'shutdown':
        case 'quit':
        case 'exit':
          server.shutdown();
          break;
        case 'help':
          console.log('\nAvailable commands:');
          console.log('  status    - Show server statistics');
          console.log('  rooms     - List all active rooms');
          console.log('  players   - List all connected players');
          console.log('  shutdown  - Gracefully shutdown the server');
          console.log('  help      - Show this help message');
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
