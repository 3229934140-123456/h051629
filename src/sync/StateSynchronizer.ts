import {
  GameState,
  StateDelta,
  HistorySnapshot,
  PlayerState,
  ServerConfig,
} from '../types';

export class StateSynchronizer {
  private config: ServerConfig;
  private currentState: GameState;
  private history: HistorySnapshot[] = [];
  private lastSnapshotFrame: number = 0;

  constructor(config: ServerConfig, initialState?: GameState) {
    this.config = config;
    this.currentState = initialState ?? {
      frame: 0,
      timestamp: Date.now(),
      players: new Map(),
      worldState: {},
    };
  }

  getCurrentState(): GameState {
    return this.cloneState(this.currentState);
  }

  setCurrentState(state: GameState): void {
    this.currentState = this.cloneState(state);
  }

  applyFrameUpdate(
    frame: number,
    playerUpdates: Map<string, PlayerState>,
    worldUpdates?: Record<string, unknown>
  ): void {
    this.currentState.frame = frame;
    this.currentState.timestamp = Date.now();

    for (const [playerId, state] of playerUpdates) {
      this.currentState.players.set(playerId, { ...state });
    }

    if (worldUpdates) {
      this.currentState.worldState = {
        ...this.currentState.worldState,
        ...worldUpdates,
      };
    }
  }

  saveHistorySnapshot(frame: number, inputs: Map<string, unknown>): void {
    const snapshot: HistorySnapshot = {
      frame,
      state: this.cloneState(this.currentState),
      inputs: inputs as Map<string, unknown extends never ? never : never>,
    };

    this.history.push(snapshot);

    while (this.history.length > this.config.maxHistorySnapshots) {
      this.history.shift();
    }
  }

  getHistorySnapshot(frame: number): HistorySnapshot | undefined {
    return this.history.find((s) => s.frame === frame);
  }

  getRecentHistory(count: number): HistorySnapshot[] {
    return this.history.slice(-count);
  }

  shouldSendFullSnapshot(frame: number): boolean {
    return frame - this.lastSnapshotFrame >= Math.floor(this.config.snapshotInterval / (1000 / this.config.tickRate));
  }

  generateFullSnapshot(frame: number): GameState {
    this.lastSnapshotFrame = frame;
    return this.cloneState(this.currentState);
  }

  generateDelta(baseFrame: number, targetFrame: number): StateDelta | null {
    const baseSnapshot = this.getHistorySnapshot(baseFrame);
    if (!baseSnapshot) {
      return null;
    }

    const playerUpdates = new Map<string, Partial<PlayerState>>();
    const removedPlayers: string[] = [];

    for (const [playerId, currentPlayer] of this.currentState.players) {
      const basePlayer = baseSnapshot.state.players.get(playerId);
      
      if (!basePlayer) {
        playerUpdates.set(playerId, { ...currentPlayer });
      } else {
        const diff = this.computePlayerDiff(basePlayer, currentPlayer);
        if (Object.keys(diff).length > 0) {
          playerUpdates.set(playerId, diff);
        }
      }
    }

    for (const playerId of baseSnapshot.state.players.keys()) {
      if (!this.currentState.players.has(playerId)) {
        removedPlayers.push(playerId);
      }
    }

    const worldUpdates = this.computeWorldDiff(
      baseSnapshot.state.worldState ?? {},
      this.currentState.worldState ?? {}
    );

    if (playerUpdates.size === 0 && removedPlayers.length === 0 && Object.keys(worldUpdates).length === 0) {
      return null;
    }

    return {
      frame: targetFrame,
      baseFrame,
      playerUpdates,
      worldUpdates,
      removedPlayers: removedPlayers.length > 0 ? removedPlayers : undefined,
    };
  }

  private computePlayerDiff(base: PlayerState, current: PlayerState): Partial<PlayerState> {
    const diff: Partial<PlayerState> = {};

    if (base.position.x !== current.position.x ||
        base.position.y !== current.position.y ||
        (base.position.z ?? 0) !== (current.position.z ?? 0)) {
      diff.position = { ...current.position };
    }

    if (base.velocity && current.velocity) {
      if (base.velocity.x !== current.velocity.x ||
          base.velocity.y !== current.velocity.y ||
          (base.velocity.z ?? 0) !== (current.velocity.z ?? 0)) {
        diff.velocity = { ...current.velocity };
      }
    } else if (current.velocity) {
      diff.velocity = { ...current.velocity };
    }

    if (base.rotation && current.rotation) {
      if (base.rotation.x !== current.rotation.x ||
          base.rotation.y !== current.rotation.y ||
          (base.rotation.z ?? 0) !== (current.rotation.z ?? 0)) {
        diff.rotation = { ...current.rotation };
      }
    } else if (current.rotation) {
      diff.rotation = { ...current.rotation };
    }

    if (base.health !== current.health) {
      diff.health = current.health;
    }

    if (base.custom || current.custom) {
      const customDiff = this.computeWorldDiff(base.custom ?? {}, current.custom ?? {});
      if (Object.keys(customDiff).length > 0) {
        diff.custom = customDiff;
      }
    }

    return diff;
  }

  private computeWorldDiff(
    base: Record<string, unknown>,
    current: Record<string, unknown>
  ): Record<string, unknown> {
    const diff: Record<string, unknown> = {};

    for (const key of Object.keys(current)) {
      if (!(key in base) || JSON.stringify(base[key]) !== JSON.stringify(current[key])) {
        diff[key] = current[key];
      }
    }

    return diff;
  }

  applyDelta(delta: StateDelta): void {
    if (delta.frame !== this.currentState.frame) {
      this.currentState.frame = delta.frame;
    }

    for (const [playerId, partial] of delta.playerUpdates) {
      const existing = this.currentState.players.get(playerId);
      if (existing) {
        if (partial.position) existing.position = { ...existing.position, ...partial.position };
        if (partial.velocity) existing.velocity = { ...existing.velocity, ...partial.velocity };
        if (partial.rotation) existing.rotation = { ...existing.rotation, ...partial.rotation };
        if (partial.health !== undefined) existing.health = partial.health;
        if (partial.custom) existing.custom = { ...existing.custom, ...partial.custom };
      } else {
        this.currentState.players.set(playerId, partial as PlayerState);
      }
    }

    if (delta.removedPlayers) {
      for (const playerId of delta.removedPlayers) {
        this.currentState.players.delete(playerId);
      }
    }

    if (delta.worldUpdates) {
      this.currentState.worldState = {
        ...this.currentState.worldState,
        ...delta.worldUpdates,
      };
    }

    this.currentState.timestamp = Date.now();
  }

  addPlayer(playerId: string, initialState: PlayerState): void {
    this.currentState.players.set(playerId, { ...initialState });
  }

  removePlayer(playerId: string): void {
    this.currentState.players.delete(playerId);
  }

  rollbackToFrame(frame: number): boolean {
    const snapshot = this.getHistorySnapshot(frame);
    if (!snapshot) {
      return false;
    }

    this.currentState = this.cloneState(snapshot.state);
    this.history = this.history.filter((s) => s.frame < frame);
    return true;
  }

  replayFromFrame(
    startFrame: number,
    applyInput: (frame: number, inputs: Map<string, unknown>) => void
  ): number {
    const startIndex = this.history.findIndex((s) => s.frame === startFrame);
    if (startIndex === -1) {
      return -1;
    }

    this.currentState = this.cloneState(this.history[startIndex].state);
    const replayFrames = this.history.slice(startIndex + 1);

    for (const snapshot of replayFrames) {
      applyInput(snapshot.frame, snapshot.inputs as Map<string, unknown>);
      this.currentState.frame = snapshot.frame;
    }

    return this.currentState.frame;
  }

  private cloneState(state: GameState): GameState {
    const clonedPlayers = new Map<string, PlayerState>();
    for (const [id, player] of state.players) {
      clonedPlayers.set(id, {
        ...player,
        position: { ...player.position },
        velocity: player.velocity ? { ...player.velocity } : undefined,
        rotation: player.rotation ? { ...player.rotation } : undefined,
        custom: player.custom ? { ...player.custom } : undefined,
      });
    }

    return {
      frame: state.frame,
      timestamp: state.timestamp,
      players: clonedPlayers,
      worldState: state.worldState ? { ...state.worldState } : undefined,
    };
  }

  serializeForReconnection(): {
    state: GameState;
    baseFrame: number;
    historyCount: number;
  } {
    return {
      state: this.cloneState(this.currentState),
      baseFrame: this.currentState.frame,
      historyCount: this.history.length,
    };
  }

  getLatestFrame(): number {
    return this.currentState.frame;
  }
}
