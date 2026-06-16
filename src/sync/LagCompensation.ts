import { HistorySnapshot, PlayerState, ServerConfig } from '../types';

interface LagCompensationResult {
  hit: boolean;
  adjustedPosition: { x: number; y: number; z?: number };
  confidence: number;
}

export class LagCompensation {
  private config: ServerConfig;

  constructor(config: ServerConfig) {
    this.config = config;
  }

  rewindToTime(
    history: HistorySnapshot[],
    targetPlayerId: string,
    clientTimestamp: number,
    serverCurrentTime: number
  ): HistorySnapshot | null {
    const latency = serverCurrentTime - clientTimestamp;
    const framesToRewind = Math.floor(latency / (1000 / this.config.tickRate));
    
    const currentFrame = history.length > 0 ? history[history.length - 1].frame : 0;
    const targetFrame = Math.max(0, currentFrame - framesToRewind);

    return this.findSnapshotAtFrame(history, targetFrame);
  }

  rewindToFrame(
    history: HistorySnapshot[],
    targetFrame: number
  ): HistorySnapshot | null {
    return this.findSnapshotAtFrame(history, targetFrame);
  }

  interpolatePlayerState(
    snapshots: HistorySnapshot[],
    targetFrame: number,
    playerId: string
  ): PlayerState | null {
    if (snapshots.length === 0) return null;

    let before: HistorySnapshot | null = null;
    let after: HistorySnapshot | null = null;

    for (let i = snapshots.length - 1; i >= 0; i--) {
      if (snapshots[i].frame <= targetFrame) {
        before = snapshots[i];
        after = i + 1 < snapshots.length ? snapshots[i + 1] : null;
        break;
      }
    }

    if (!before) return null;

    const beforeState = before.state.players.get(playerId);
    if (!beforeState) return null;

    if (!after || before.frame === targetFrame) {
      return { ...beforeState };
    }

    const afterState = after.state.players.get(playerId);
    if (!afterState) {
      return { ...beforeState };
    }

    const t = (targetFrame - before.frame) / (after.frame - before.frame);
    return this.interpolateStates(beforeState, afterState, t);
  }

  checkHitWithRewind(
    history: HistorySnapshot[],
    attackerId: string,
    targetId: string,
    hitPosition: { x: number; y: number; z?: number },
    clientTimestamp: number,
    serverCurrentTime: number,
    hitRadius: number = 1.0
  ): LagCompensationResult {
    const rewound = this.rewindToTime(history, targetId, clientTimestamp, serverCurrentTime);

    if (!rewound) {
      return { hit: false, adjustedPosition: hitPosition, confidence: 0 };
    }

    const targetState = rewound.state.players.get(targetId);
    if (!targetState) {
      return { hit: false, adjustedPosition: hitPosition, confidence: 0 };
    }

    const distance = this.calculateDistance(hitPosition, targetState.position);
    const hit = distance <= hitRadius;
    
    const latency = serverCurrentTime - clientTimestamp;
    const maxAcceptableLatency = 500;
    const confidence = hit ? Math.max(0, 1 - latency / maxAcceptableLatency) : 0;

    return {
      hit,
      adjustedPosition: { ...targetState.position },
      confidence,
    };
  }

  calculateClientSidePredictionError(
    serverState: PlayerState,
    clientPredictedState: PlayerState
  ): {
    positionError: number;
    velocityError?: number;
    needsCorrection: boolean;
  } {
    const positionError = this.calculateDistance(
      serverState.position,
      clientPredictedState.position
    );

    const correctionThreshold = 0.5;
    const needsCorrection = positionError > correctionThreshold;

    let velocityError: number | undefined;
    if (serverState.velocity && clientPredictedState.velocity) {
      velocityError = this.calculateDistance(
        serverState.velocity,
        clientPredictedState.velocity
      );
    }

    return {
      positionError,
      velocityError,
      needsCorrection,
    };
  }

  generateCorrectionPayload(
    playerId: string,
    serverFrame: number,
    serverState: PlayerState,
    clientLastAckedFrame: number
  ): {
    type: 'correction';
    playerId: string;
    serverFrame: number;
    baseFrame: number;
    position: { x: number; y: number; z?: number };
    velocity?: { x: number; y: number; z?: number };
    rotation?: { x: number; y: number; z?: number };
  } {
    return {
      type: 'correction',
      playerId,
      serverFrame,
      baseFrame: clientLastAckedFrame,
      position: { ...serverState.position },
      velocity: serverState.velocity ? { ...serverState.velocity } : undefined,
      rotation: serverState.rotation ? { ...serverState.rotation } : undefined,
    };
  }

  estimateServerFrameFromClient(
    clientFrame: number,
    clientRtt: number,
    serverCurrentFrame: number
  ): number {
    const oneWayLatencyFrames = Math.ceil((clientRtt / 2) / (1000 / this.config.tickRate));
    return Math.max(0, serverCurrentFrame - oneWayLatencyFrames);
  }

  private findSnapshotAtFrame(
    history: HistorySnapshot[],
    targetFrame: number
  ): HistorySnapshot | null {
    if (history.length === 0) return null;

    let left = 0;
    let right = history.length - 1;

    while (left <= right) {
      const mid = Math.floor((left + right) / 2);
      if (history[mid].frame === targetFrame) {
        return history[mid];
      } else if (history[mid].frame < targetFrame) {
        left = mid + 1;
      } else {
        right = mid - 1;
      }
    }

    if (right >= 0) {
      return history[right];
    }

    return history[0];
  }

  private interpolateStates(
    a: PlayerState,
    b: PlayerState,
    t: number
  ): PlayerState {
    const clampT = Math.max(0, Math.min(1, t));

    return {
      id: a.id,
      position: this.lerpVector(a.position, b.position, clampT),
      velocity: a.velocity && b.velocity ? this.lerpVector(a.velocity, b.velocity, clampT) : undefined,
      rotation: a.rotation && b.rotation ? this.lerpVector(a.rotation, b.rotation, clampT) : undefined,
      health: a.health + (b.health - a.health) * clampT,
      custom: b.custom ?? a.custom,
    };
  }

  private lerpVector(
    a: { x: number; y: number; z?: number },
    b: { x: number; y: number; z?: number },
    t: number
  ): { x: number; y: number; z?: number } {
    return {
      x: a.x + (b.x - a.x) * t,
      y: a.y + (b.y - a.y) * t,
      z: a.z !== undefined && b.z !== undefined ? a.z + (b.z - a.z) * t : undefined,
    };
  }

  calculateDistance(
    a: { x: number; y: number; z?: number },
    b: { x: number; y: number; z?: number }
  ): number {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const dz = (b.z ?? 0) - (a.z ?? 0);
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }
}
