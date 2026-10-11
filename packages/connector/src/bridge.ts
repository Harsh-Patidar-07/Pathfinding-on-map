/**
 * PathfinderConnector: Client bridge for managing Web Worker lifecycle,
 * animation playback, and typed array views.
 */

import {
  CompleteResult,
  GraphData,
  SearchAlgorithm,
  SearchOptions,
  SearchStatus,
  StepResult,
  WorkerMessageIn,
  WorkerMessageInPayload,
  WorkerMessageOut,
} from './types.js';
import { PathfinderWorkerHandler } from './worker.js';

export interface ConnectorOptions {
  /** Optional pre-created Web Worker instance */
  worker?: Worker;
  /** Optional URL or path to worker script */
  workerUrl?: string | URL;
  /** Preloaded Wasm binary (ArrayBuffer or Uint8Array) */
  wasmBinary?: ArrayBuffer | Uint8Array;
  /** Optional URL to fetch pathfinder_wasm_bg.wasm */
  wasmUrl?: string;
  /**
   * Run directly in the host thread using PathfinderWorkerHandler.
   * Enables true 100% zero-copy buffer sharing without Web Worker IPC serialization.
   * Default: false (uses Web Worker)
   */
  directMode?: boolean;
  /** Default batch size for steps (default: 64) */
  defaultBatchSize?: number;
  /** Playback target frames per second (default: 60) */
  fps?: number;
}

export type StepCallback = (result: StepResult) => void;
export type CompleteCallback = (result: CompleteResult) => void;
export type ErrorCallback = (error: Error) => void;

/**
 * High-level TypeScript controller for Pathfinder.
 */
export class PathfinderConnector {
  private worker: Worker | null = null;
  private directHandler: PathfinderWorkerHandler | null = null;
  private options: ConnectorOptions;

  private messageIdCounter = 0;
  private pendingRequests = new Map<
    number,
    {
      resolve: (value: any) => void;
      reject: (error: any) => void;
    }
  >();

  private stepListeners = new Set<StepCallback>();
  private completeListeners = new Set<CompleteCallback>();
  private errorListeners = new Set<ErrorCallback>();

  private isRunningSearch = false;
  private playbackTimer: any = null;
  private currentStatus: SearchStatus = SearchStatus.NotStarted;
  private lastStepResult: StepResult | null = null;
  private isTerminated = false;

  constructor(options: ConnectorOptions = {}) {
    this.options = {
      defaultBatchSize: 64,
      fps: 60,
      directMode: false,
      ...options,
    };
  }

  /**
   * Initializes the connector and starts the worker or direct engine.
   */
  public async init(): Promise<void> {
    if (this.options.directMode) {
      this.directHandler = new PathfinderWorkerHandler();
      await this.directHandler.init(
        this.options.wasmBinary,
        this.options.wasmUrl
      );
      return;
    }

    // Worker mode
    if (this.options.worker) {
      this.worker = this.options.worker;
    } else if (this.options.workerUrl) {
      this.worker = new Worker(this.options.workerUrl, { type: 'module' });
    } else if (typeof Worker !== 'undefined') {
      // Default to bundling worker URL relative to this module
      const defaultWorkerUrl = new URL('./worker.js', import.meta.url);
      this.worker = new Worker(defaultWorkerUrl, { type: 'module' });
    } else {
      // Fallback to direct mode if Worker is unavailable in environment (e.g. Node.js tests)
      this.directHandler = new PathfinderWorkerHandler();
      await this.directHandler.init(
        this.options.wasmBinary,
        this.options.wasmUrl
      );
      return;
    }

    this.worker.onmessage = (event: MessageEvent<WorkerMessageOut>) => {
      this.handleWorkerMessage(event.data);
    };

    this.worker.onerror = (err) => {
      const error = new Error(`Worker error: ${err.message || 'Unknown error'}`);
      this.emitError(error);
    };

    await this.postMessageAsync({
      type: 'INIT',
      wasmBinary: this.options.wasmBinary,
      wasmUrl: this.options.wasmUrl,
    });
  }

  /**
   * Loads flat CSR graph data into the pathfinder engine.
   */
  public async loadGraph(
    graph: GraphData
  ): Promise<{ nodeCount: number; edgeCount: number; nodesPtr: number; nodesLen: number }> {
    if (this.directHandler) {
      const res = this.directHandler.loadGraph(
        graph.coords,
        graph.offsets,
        graph.targets,
        graph.weights
      );
      return res;
    }

    const res = await this.postMessageAsync({
      type: 'LOAD_GRAPH',
      graph,
    });
    return res;
  }

  /**
   * Initiates a new pathfinding query.
   */
  public async startSearch(options: SearchOptions): Promise<SearchStatus> {
    this.pause();
    const algorithm = options.algorithm ?? SearchAlgorithm.Dijkstra;
    const bidirectional = options.bidirectional ?? false;

    if (this.directHandler) {
      const status = this.directHandler.startSearch(
        options.startNode,
        options.targetNode,
        algorithm,
        bidirectional
      );
      this.currentStatus = status;
      this.isRunningSearch = status === SearchStatus.InProgress;
      this.lastStepResult = null;
      return status;
    }

    const res = await this.postMessageAsync({
      type: 'START_SEARCH',
      startNode: options.startNode,
      targetNode: options.targetNode,
      algorithm,
      bidirectional,
    });

    this.currentStatus = res.status;
    this.isRunningSearch = res.status === SearchStatus.InProgress;
    this.lastStepResult = null;
    return res.status;
  }

  /**
   * Steps the search forward by `batchSize` expansions.
   */
  public async step(batchSize?: number): Promise<StepResult> {
    const size = batchSize ?? this.options.defaultBatchSize ?? 64;

    let stepResult: StepResult;
    if (this.directHandler) {
      stepResult = this.directHandler.step(size);
    } else {
      const res = await this.postMessageAsync({
        type: 'STEP',
        batchSize: size,
      });
      stepResult = res.stepResult;
    }

    this.currentStatus = stepResult.status;
    this.lastStepResult = stepResult;
    this.emitStep(stepResult);

    if (stepResult.isCompleted) {
      this.isRunningSearch = false;
      this.pause();

      if (stepResult.isFound && stepResult.finalPathNodes) {
        this.emitComplete({
          found: true,
          pathCost: stepResult.pathCost,
          finalPathNodes: stepResult.finalPathNodes,
          finalPathEdges: stepResult.finalPathEdges ?? new Uint32Array(0),
          totalVisitedEdges: stepResult.visitedEdgesCount,
        });
      } else {
        this.emitComplete({
          found: false,
          pathCost: -1,
          finalPathNodes: new Uint32Array(0),
          finalPathEdges: new Uint32Array(0),
          totalVisitedEdges: stepResult.visitedEdgesCount,
        });
      }
    }

    return stepResult;
  }

  /**
   * Starts playback, stepping the search continuously at the target FPS.
   */
  public play(playbackOptions?: { batchSize?: number; fps?: number }): void {
    if (this.playbackTimer !== null) {
      return; // Already playing
    }

    const batchSize =
      playbackOptions?.batchSize ?? this.options.defaultBatchSize ?? 64;
    const targetFps = playbackOptions?.fps ?? this.options.fps ?? 60;
    const intervalMs = Math.max(1, Math.floor(1000 / targetFps));

    const loop = async () => {
      if (this.playbackTimer === null || this.isTerminated) {
        return;
      }

      try {
        const result = await this.step(batchSize);
        if (result.isCompleted) {
          this.pause();
          return;
        }
      } catch (err: any) {
        this.emitError(err);
        this.pause();
        return;
      }

      if (this.playbackTimer !== null) {
        this.scheduleNextFrame(loop, intervalMs);
      }
    };

    this.playbackTimer = 1; // Mark active
    this.scheduleNextFrame(loop, intervalMs);
  }

  /**
   * Pauses active playback.
   */
  public pause(): void {
    if (this.playbackTimer !== null) {
      if (typeof cancelAnimationFrame === 'function' && typeof this.playbackTimer === 'number' && this.playbackTimer > 1) {
        cancelAnimationFrame(this.playbackTimer);
      } else {
        clearTimeout(this.playbackTimer);
      }
      this.playbackTimer = null;
    }
  }

  /**
   * Resets the active search query.
   */
  public async reset(): Promise<void> {
    this.pause();
    this.isRunningSearch = false;
    this.lastStepResult = null;
    this.currentStatus = SearchStatus.NotStarted;

    if (this.directHandler) {
      this.directHandler.reset();
      return;
    }

    await this.postMessageAsync({ type: 'RESET' });
  }

  /**
   * Subscribes to step updates. Returns unsubscribe function.
   */
  public onStep(callback: StepCallback): () => void {
    this.stepListeners.add(callback);
    return () => this.stepListeners.delete(callback);
  }

  /**
   * Subscribes to search completion. Returns unsubscribe function.
   */
  public onComplete(callback: CompleteCallback): () => void {
    this.completeListeners.add(callback);
    return () => this.completeListeners.delete(callback);
  }

  /**
   * Subscribes to errors. Returns unsubscribe function.
   */
  public onError(callback: ErrorCallback): () => void {
    this.errorListeners.add(callback);
    return () => this.errorListeners.delete(callback);
  }

  /**
   * Returns whether playback is currently running.
   */
  public get isPlaying(): boolean {
    return this.playbackTimer !== null;
  }

  /**
   * Returns current search status.
   */
  public get status(): SearchStatus {
    return this.currentStatus;
  }

  /**
   * Returns the most recent step result.
   */
  public get latestResult(): StepResult | null {
    return this.lastStepResult;
  }

  /**
   * In direct mode, returns zero-copy Uint32Array view over Wasm linear memory
   * for visited edges.
   */
  public getVisitedEdgesView(): Uint32Array | null {
    if (!this.directHandler || !this.lastStepResult) {
      return null;
    }
    const buf = this.directHandler.getMemoryBuffer();
    if (!buf) return null;
    return new Uint32Array(
      buf,
      this.lastStepResult.visitedEdgesPtr,
      this.lastStepResult.visitedEdgesCount
    );
  }

  /**
   * Terminates worker and stops playback.
   */
  public terminate(): void {
    this.pause();
    this.isTerminated = true;
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    this.directHandler = null;
    this.stepListeners.clear();
    this.completeListeners.clear();
    this.errorListeners.clear();
  }

  // --------------------------------------------------------------------------
  // Internal Helpers
  // --------------------------------------------------------------------------

  private scheduleNextFrame(cb: () => void, delayMs: number): void {
    if (typeof requestAnimationFrame === 'function' && delayMs <= 16) {
      this.playbackTimer = requestAnimationFrame(() => cb());
    } else {
      this.playbackTimer = setTimeout(() => cb(), delayMs);
    }
  }

  private postMessageAsync(
    msgPayload: WorkerMessageInPayload
  ): Promise<any> {
    if (!this.worker) {
      return Promise.reject(new Error('Worker is not initialized'));
    }

    const id = ++this.messageIdCounter;
    const msg = { ...msgPayload, id } as WorkerMessageIn;

    return new Promise((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject });
      this.worker!.postMessage(msg);
    });
  }

  private handleWorkerMessage(msg: WorkerMessageOut): void {
    const pending = this.pendingRequests.get(msg.id);
    if (pending) {
      this.pendingRequests.delete(msg.id);
      if (msg.type === 'ERROR') {
        pending.reject(new Error(msg.error));
        this.emitError(new Error(msg.error));
      } else {
        pending.resolve(msg);
      }
    }
  }

  private emitStep(result: StepResult): void {
    for (const listener of this.stepListeners) {
      try {
        listener(result);
      } catch (err) {
        console.error('Error in step listener:', err);
      }
    }
  }

  private emitComplete(result: CompleteResult): void {
    for (const listener of this.completeListeners) {
      try {
        listener(result);
      } catch (err) {
        console.error('Error in complete listener:', err);
      }
    }
  }

  private emitError(error: Error): void {
    for (const listener of this.errorListeners) {
      try {
        listener(error);
      } catch (err) {
        console.error('Error in error listener:', err);
      }
    }
  }
}
