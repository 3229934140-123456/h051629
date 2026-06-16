import { EventEmitter } from 'events';
import {
  PlayerInput,
  PlayerState,
  InputData,
  ServerConfig,
} from '../types';
import { InputBuffer } from '../input/InputBuffer';
import { StateSynchronizer } from '../sync/StateSynchronizer';
import { LagCompensation } from '../sync/LagCompensation';

interface SlowOperation {
  id: string;
  frame: number;
  operation: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
  timeout: NodeJS.Timeout;
}

type GameLogicCallback = (
  frame: number,
  deltaTime: number,
  inputs: Map<string, PlayerInput[]>,
  state: Map<string, PlayerState>
) => Map<string, PlayerState> | Promise<Map<string, PlayerState>>;

export class GameLoop extends EventEmitter {
  private config: ServerConfig;
  private inputBuffer: InputBuffer;
  private stateSynchronizer: StateSynchronizer;
  private lagCompensation: LagCompensation;
  private gameLogic: GameLogicCallback | null = null;

  private isRunning = false;
  private loopTimer: NodeJS.Timeout | null = null;
  private lastFrameTime: bigint = 0n;
  private accumulator = 0;
  private currentFrame = 0;
  private tickInterval: number;

  private slowOperationQueue: SlowOperation[] = [];
  private pendingSlowOperations: Map<string, SlowOperation> = new Map();

  constructor(
    config: ServerConfig,
    inputBuffer: InputBuffer,
    stateSynchronizer: StateSynchronizer,
    lagCompensation: LagCompensation
  ) {
    super();
    this.config = config;
    this.inputBuffer = inputBuffer;
    this.stateSynchronizer = stateSynchronizer;
    this.lagCompensation = lagCompensation;
    this.tickInterval = 1000 / config.tickRate;
  }

  setGameLogic(callback: GameLogicCallback): void {
    this.gameLogic = callback;
  }

  start(): void {
    if (this.isRunning) return;

    this.isRunning = true;
    this.lastFrameTime = process.hrtime.bigint();
    this.currentFrame = this.stateSynchronizer.getLatestFrame();

    console.log(`[GameLoop] Starting game loop at ${this.config.tickRate}Hz (${this.tickInterval.toFixed(2)}ms per tick)`);

    this.runLoop();
  }

  stop(): void {
    this.isRunning = false;
    if (this.loopTimer) {
      clearTimeout(this.loopTimer);
      this.loopTimer = null;
    }
    console.log('[GameLoop] Game loop stopped');
  }

  private runLoop = (): void => {
    if (!this.isRunning) return;

    const now = process.hrtime.bigint();
    const frameTime = Number(now - this.lastFrameTime) / 1_000_000;
    this.lastFrameTime = now;

    this.accumulator += frameTime;

    while (this.accumulator >= this.tickInterval) {
      this.processFrame();
      this.accumulator -= this.tickInterval;
    }

    this.processSlowOperations();

    const sleepTime = Math.max(0, this.tickInterval - this.accumulator);
    this.loopTimer = setTimeout(this.runLoop, sleepTime);
  };

  private async processFrame(): Promise<void> {
    const frameStartTime = Date.now();
    this.currentFrame++;

    const frameInputs = this.inputBuffer.getInputsForFrame(this.currentFrame);
    const deltaTime = this.tickInterval / 1000;

    const currentState = this.stateSynchronizer.getCurrentState();
    const playerStates = new Map<string, PlayerState>();
    for (const [id, state] of currentState.players) {
      playerStates.set(id, { ...state });
    }

    let newStates: Map<string, PlayerState>;

    if (this.gameLogic) {
      try {
        const result = this.gameLogic(this.currentFrame, deltaTime, frameInputs, playerStates);
        
        if (result instanceof Promise) {
          const executeTime = Date.now();
          newStates = await Promise.race([
            result,
            new Promise<Map<string, PlayerState>>((_, reject) => {
              setTimeout(() => {
                reject(new Error('Game logic timeout'));
              }, this.config.slowOperationTimeoutMs);
            }),
          ]);
          
          const totalTime = Date.now() - executeTime;
          if (totalTime > this.config.slowOperationTimeoutMs) {
            console.warn(`[GameLoop] Frame ${this.currentFrame} game logic took ${totalTime}ms, exceeding threshold ${this.config.slowOperationTimeoutMs}ms`);
          }
        } else {
          newStates = result;
        }
      } catch (error) {
        console.error(`[GameLoop] Error in game logic for frame ${this.currentFrame}:`, error);
        newStates = playerStates;
      }
    } else {
      newStates = this.defaultGameLogic(this.currentFrame, deltaTime, frameInputs, playerStates);
    }

    this.stateSynchronizer.applyFrameUpdate(this.currentFrame, newStates);
    this.stateSynchronizer.saveHistorySnapshot(this.currentFrame, frameInputs as Map<string, unknown>);

    const frameDuration = Date.now() - frameStartTime;
    if (frameDuration > this.config.slowOperationTimeoutMs) {
      console.warn(`[GameLoop] Frame ${this.currentFrame} total processing took ${frameDuration}ms`);
    }

    this.emit('frame-complete', {
      frame: this.currentFrame,
      duration: frameDuration,
      inputs: frameInputs,
      state: this.stateSynchronizer.getCurrentState(),
    });
  };

  private defaultGameLogic(
    _frame: number,
    deltaTime: number,
    inputs: Map<string, PlayerInput[]>,
    currentStates: Map<string, PlayerState>
  ): Map<string, PlayerState> {
    const newStates = new Map<string, PlayerState>();

    for (const [playerId, state] of currentStates) {
      const playerInputs = inputs.get(playerId) || [];
      const newState = this.applyInputToState(state, playerInputs, deltaTime);
      newStates.set(playerId, newState);
    }

    return newStates;
  }

  private applyInputToState(
    state: PlayerState,
    inputs: PlayerInput[],
    deltaTime: number
  ): PlayerState {
    const newState = { ...state };

    let moveX = 0;
    let moveY = 0;
    const speed = 5.0;

    for (const input of inputs) {
      const inputData = input.inputData;
      moveX += inputData.moveX ?? 0;
      moveY += inputData.moveY ?? 0;
    }

    if (inputs.length > 0) {
      moveX /= inputs.length;
      moveY /= inputs.length;
    }

    const magnitude = Math.sqrt(moveX * moveX + moveY * moveY);
    if (magnitude > 0) {
      moveX /= magnitude;
      moveY /= magnitude;
    }

    newState.position = {
      x: state.position.x + moveX * speed * deltaTime,
      y: state.position.y + moveY * speed * deltaTime,
      z: state.position.z ?? 0,
    };

    return newState;
  }

  queueSlowOperation<T>(
    operation: () => Promise<T>,
    timeoutMs?: number
  ): Promise<T> {
    const operationId = `slow-op-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const timeout = timeoutMs ?? 5000;

    return new Promise((resolve, reject) => {
      const slowOp: SlowOperation = {
        id: operationId,
        frame: this.currentFrame,
        operation: operation as () => Promise<unknown>,
        resolve: resolve as (value: unknown) => void,
        reject,
        timeout: setTimeout(() => {
          this.pendingSlowOperations.delete(operationId);
          reject(new Error(`Slow operation ${operationId} timed out after ${timeout}ms`));
        }, timeout),
      };

      this.slowOperationQueue.push(slowOp);
    });
  }

  private processSlowOperations(): void {
    const maxConcurrent = 4;
    const canProcess = Math.min(
      this.slowOperationQueue.length,
      maxConcurrent - this.pendingSlowOperations.size
    );

    for (let i = 0; i < canProcess; i++) {
      const slowOp = this.slowOperationQueue.shift();
      if (!slowOp) break;

      this.pendingSlowOperations.set(slowOp.id, slowOp);

      slowOp
        .operation()
        .then((result) => {
          clearTimeout(slowOp.timeout);
          this.pendingSlowOperations.delete(slowOp.id);
          slowOp.resolve(result);
        })
        .catch((error) => {
          clearTimeout(slowOp.timeout);
          this.pendingSlowOperations.delete(slowOp.id);
          slowOp.reject(error);
        });
    }
  }

  addPlayerInput(playerId: string, inputData: InputData, frame?: number): void {
    const targetFrame = frame ?? this.currentFrame;
    const playerInput: PlayerInput = {
      playerId,
      frame: targetFrame,
      inputData,
      timestamp: Date.now(),
    };
    this.inputBuffer.addInput(playerId, playerInput);
  }

  getCurrentFrame(): number {
    return this.currentFrame;
  }

  getTickRate(): number {
    return this.config.tickRate;
  }

  getTickInterval(): number {
    return this.tickInterval;
  }

  getLagCompensation(): LagCompensation {
    return this.lagCompensation;
  }

  getStateSynchronizer(): StateSynchronizer {
    return this.stateSynchronizer;
  }

  getInputBuffer(): InputBuffer {
    return this.inputBuffer;
  }

  isLoopRunning(): boolean {
    return this.isRunning;
  }

  getStats(): {
    currentFrame: number;
    isRunning: boolean;
    tickInterval: number;
    pendingSlowOps: number;
    queuedSlowOps: number;
  } {
    return {
      currentFrame: this.currentFrame,
      isRunning: this.isRunning,
      tickInterval: this.tickInterval,
      pendingSlowOps: this.pendingSlowOperations.size,
      queuedSlowOps: this.slowOperationQueue.length,
    };
  }
}
