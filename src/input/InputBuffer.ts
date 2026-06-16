import { PlayerInput, InputData, ServerConfig } from '../types';

interface BufferedInput {
  input: PlayerInput;
  processed: boolean;
  receivedAt: number;
}

export class InputBuffer {
  private config: ServerConfig;
  private playerBuffers: Map<string, Map<number, BufferedInput>> = new Map();
  private lastProcessedFrame: Map<string, number> = new Map();
  private _onInputReady: ((inputs: Map<string, PlayerInput[]>, frame: number) => void) | null = null;

  constructor(config: ServerConfig) {
    this.config = config;
  }

  setInputReadyCallback(callback: (inputs: Map<string, PlayerInput[]>, frame: number) => void): void {
    this._onInputReady = callback;
  }

  addInput(playerId: string, input: PlayerInput): void {
    let buffer = this.playerBuffers.get(playerId);
    if (!buffer) {
      buffer = new Map();
      this.playerBuffers.set(playerId, buffer);
    }

    const lastProcessed = this.lastProcessedFrame.get(playerId) ?? -1;
    if (input.frame <= lastProcessed) {
      return;
    }

    if (!buffer.has(input.frame)) {
      buffer.set(input.frame, {
        input,
        processed: false,
        receivedAt: Date.now(),
      });
    }

    this.trimBuffer(playerId);
  }

  getInputsForFrame(frame: number): Map<string, PlayerInput[]> {
    const result = new Map<string, PlayerInput[]>();
    const playerIds = Array.from(this.playerBuffers.keys()).sort();

    for (const playerId of playerIds) {
      const buffer = this.playerBuffers.get(playerId)!;
      const inputs: PlayerInput[] = [];
      const buffered = buffer.get(frame);
      
      if (buffered && !buffered.processed) {
        inputs.push(buffered.input);
        buffered.processed = true;
      } else {
        inputs.push(this.createPredictedInput(playerId, frame));
      }

      const lastProcessed = this.lastProcessedFrame.get(playerId) ?? -1;
      if (frame > lastProcessed) {
        this.lastProcessedFrame.set(playerId, frame);
      }

      if (inputs.length > 0) {
        result.set(playerId, inputs);
      }
    }

    if (this._onInputReady) {
      this._onInputReady(result, frame);
    }

    return result;
  }

  getMissingFrames(playerId: string, currentFrame: number): number[] {
    const buffer = this.playerBuffers.get(playerId);
    if (!buffer) return [];

    const missing: number[] = [];
    const startFrame = (this.lastProcessedFrame.get(playerId) ?? currentFrame - this.config.inputBufferSize) + 1;

    for (let f = startFrame; f < currentFrame; f++) {
      if (!buffer.has(f)) {
        missing.push(f);
      }
    }

    return missing;
  }

  private createPredictedInput(playerId: string, frame: number): PlayerInput {
    const buffer = this.playerBuffers.get(playerId);
    let lastInput: PlayerInput | null = null;

    if (buffer) {
      for (let f = frame - 1; f >= 0; f--) {
        const entry = buffer.get(f);
        if (entry) {
          lastInput = entry.input;
          break;
        }
      }
    }

    const inputData: InputData = lastInput?.inputData ?? {
      moveX: 0,
      moveY: 0,
      action1: false,
      action2: false,
    };

    return {
      playerId,
      frame,
      inputData,
      timestamp: Date.now(),
    };
  }

  private trimBuffer(playerId: string): void {
    const buffer = this.playerBuffers.get(playerId);
    if (!buffer) return;

    const lastProcessed = this.lastProcessedFrame.get(playerId) ?? 0;
    const minFrame = Math.max(0, lastProcessed - this.config.maxHistorySnapshots);

    for (const frame of buffer.keys()) {
      if (frame < minFrame) {
        buffer.delete(frame);
      }
    }
  }

  removePlayer(playerId: string): void {
    this.playerBuffers.delete(playerId);
    this.lastProcessedFrame.delete(playerId);
  }

  renamePlayer(oldId: string, newId: string): void {
    const buffer = this.playerBuffers.get(oldId);
    if (buffer) {
      this.playerBuffers.delete(oldId);
      this.playerBuffers.set(newId, buffer);
    }

    const lastProcessed = this.lastProcessedFrame.get(oldId);
    if (lastProcessed !== undefined) {
      this.lastProcessedFrame.delete(oldId);
      this.lastProcessedFrame.set(newId, lastProcessed);
    }
  }

  clearAll(): void {
    this.playerBuffers.clear();
    this.lastProcessedFrame.clear();
  }

  getBufferStatus(playerId: string): {
    bufferedFrames: number;
    lastProcessedFrame: number;
    missingFrames: number[];
  } {
    const buffer = this.playerBuffers.get(playerId);
    const lastProcessed = this.lastProcessedFrame.get(playerId) ?? 0;
    const bufferedFrames = buffer ? [...buffer.keys()].filter(f => f >= lastProcessed).length : 0;

    return {
      bufferedFrames,
      lastProcessedFrame: lastProcessed,
      missingFrames: this.getMissingFrames(playerId, lastProcessed + bufferedFrames),
    };
  }
}
