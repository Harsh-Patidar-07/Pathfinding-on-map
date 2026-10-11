/**
 * Web Worker for Pathfinder Wasm engine.
 *
 * Runs search execution on a background thread and performs zero-copy
 * memory reads directly from Wasm linear memory.
 */

import init, {
  InitOutput,
  WasmPathfinder,
} from '../wasm/pathfinder_wasm.js';
import {
  SearchStatus,
  StepResult,
  WorkerMessageIn,
  WorkerMessageOut,
} from './types.js';

export class PathfinderWorkerHandler {
  private wasmInstance: InitOutput | null = null;
  private pathfinder: WasmPathfinder | null = null;

  /**
   * Initializes Wasm module and Pathfinder instance.
   */
  public async init(
    wasmBinary?: ArrayBuffer | Uint8Array,
    wasmUrl?: string
  ): Promise<void> {
    const input = wasmBinary ?? wasmUrl;
    if (input) {
      this.wasmInstance = await init({ module_or_path: input as any });
    } else {
      this.wasmInstance = await init();
    }
    this.pathfinder = new WasmPathfinder();
  }

  /**
   * Loads graph topology into the Wasm pathfinder.
   */
  public loadGraph(
    coords: Float32Array,
    offsets: Uint32Array,
    targets: Uint32Array,
    weights: Float32Array
  ): { nodeCount: number; edgeCount: number; nodesPtr: number; nodesLen: number } {
    if (!this.pathfinder) {
      throw new Error('Pathfinder Wasm not initialized');
    }
    this.pathfinder.load_graph_u32(coords, offsets, targets, weights);
    return {
      nodeCount: this.pathfinder.node_count(),
      edgeCount: this.pathfinder.edge_count(),
      nodesPtr: this.pathfinder.nodes_ptr(),
      nodesLen: this.pathfinder.nodes_len(),
    };
  }

  /**
   * Starts a new pathfinding search query.
   */
  public startSearch(
    startNode: number,
    targetNode: number,
    algorithm: number,
    bidirectional: boolean
  ): SearchStatus {
    if (!this.pathfinder) {
      throw new Error('Pathfinder Wasm not initialized');
    }
    this.pathfinder.start_search(
      startNode,
      targetNode,
      algorithm,
      bidirectional
    );
    return this.pathfinder.status() as SearchStatus;
  }

  /**
   * Steps the search and creates zero-copy TypedArray views directly
   * on Wasm linear memory.
   */
  public step(batchSize: number): StepResult {
    if (!this.pathfinder || !this.wasmInstance) {
      throw new Error('Pathfinder Wasm not initialized');
    }

    const isRunning = this.pathfinder.step(batchSize);
    const status = this.pathfinder.status() as SearchStatus;
    const isFound = this.pathfinder.is_found();
    const isCompleted =
      status === SearchStatus.Found || status === SearchStatus.NotFound;

    const visitedEdgesPtr = this.pathfinder.visited_edges_ptr();
    const visitedEdgesCount = this.pathfinder.visited_edges_len();
    const newlyVisitedEdgesPtr = this.pathfinder.newly_visited_edges_ptr();
    const newlyVisitedEdgesCount = this.pathfinder.newly_visited_edges_len();

    const finalPathPtr = this.pathfinder.final_path_ptr();
    const finalPathLen = this.pathfinder.final_path_len();
    const finalPathEdgesPtr = this.pathfinder.final_path_edges_ptr();
    const finalPathEdgesLen = this.pathfinder.final_path_edges_len();
    const pathCost = this.pathfinder.path_cost();

    // ------------------------------------------------------------------------
    // Zero-Copy Linear Memory Mapping
    // Reading raw pointers directly as TypedArrays over wasm.memory.buffer:
    // ------------------------------------------------------------------------
    const memoryBuffer = this.wasmInstance.memory.buffer;

    const visitedEdgesView = new Uint32Array(
      memoryBuffer,
      visitedEdgesPtr,
      visitedEdgesCount
    );
    const newlyVisitedEdgesView = new Uint32Array(
      memoryBuffer,
      newlyVisitedEdgesPtr,
      newlyVisitedEdgesCount
    );

    let finalPathNodesView: Uint32Array | undefined;
    let finalPathEdgesView: Uint32Array | undefined;

    if (isCompleted && isFound) {
      finalPathNodesView = new Uint32Array(
        memoryBuffer,
        finalPathPtr,
        finalPathLen
      );
      finalPathEdgesView = new Uint32Array(
        memoryBuffer,
        finalPathEdgesPtr,
        finalPathEdgesLen
      );
    }

    return {
      status,
      isRunning,
      isCompleted,
      isFound,
      visitedEdgesCount,
      newlyVisitedEdgesCount,
      visitedEdgesPtr,
      newlyVisitedEdgesPtr,
      finalPathPtr,
      finalPathLen,
      finalPathEdgesPtr,
      finalPathEdgesLen,
      pathCost,
      // Provide sliced copies for posting across worker boundary
      visitedEdges: visitedEdgesView.slice(),
      newlyVisitedEdges: newlyVisitedEdgesView.slice(),
      finalPathNodes: finalPathNodesView ? finalPathNodesView.slice() : undefined,
      finalPathEdges: finalPathEdgesView ? finalPathEdgesView.slice() : undefined,
    };
  }

  /**
   * Resets the search state.
   */
  public reset(): boolean {
    if (!this.pathfinder) {
      return false;
    }
    return this.pathfinder.reset();
  }

  /**
   * Raw access to Wasm linear memory ArrayBuffer.
   */
  public getMemoryBuffer(): ArrayBuffer | null {
    return this.wasmInstance ? this.wasmInstance.memory.buffer : null;
  }

  /**
   * Processes a structured Worker message.
   */
  public async handleMessage(
    msg: WorkerMessageIn,
    postResponse: (response: WorkerMessageOut) => void
  ): Promise<void> {
    try {
      switch (msg.type) {
        case 'INIT': {
          await this.init(msg.wasmBinary, msg.wasmUrl);
          postResponse({ id: msg.id, type: 'INIT_OK' });
          break;
        }

        case 'LOAD_GRAPH': {
          const { coords, offsets, targets, weights } = msg.graph;
          const info = this.loadGraph(coords, offsets, targets, weights);
          postResponse({
            id: msg.id,
            type: 'GRAPH_LOADED',
            ...info,
          });
          break;
        }

        case 'START_SEARCH': {
          const status = this.startSearch(
            msg.startNode,
            msg.targetNode,
            msg.algorithm,
            msg.bidirectional
          );
          postResponse({
            id: msg.id,
            type: 'SEARCH_STARTED',
            startNode: msg.startNode,
            targetNode: msg.targetNode,
            status,
          });
          break;
        }

        case 'STEP': {
          const stepResult = this.step(msg.batchSize);
          postResponse({
            id: msg.id,
            type: 'STEP_UPDATE',
            stepResult,
          });
          break;
        }

        case 'RESET': {
          this.reset();
          postResponse({ id: msg.id, type: 'RESET_OK' });
          break;
        }

        default:
          throw new Error(`Unhandled message type: ${(msg as any).type}`);
      }
    } catch (err: any) {
      postResponse({
        id: msg.id,
        type: 'ERROR',
        error: err?.message || String(err),
      });
    }
  }
}

// ----------------------------------------------------------------------------
// Worker Global Scope Binding
// Automatically activates when executed inside a Web Worker thread:
// ----------------------------------------------------------------------------
const globalScope: any =
  typeof self !== 'undefined'
    ? self
    : typeof globalThis !== 'undefined'
    ? globalThis
    : null;

if (
  globalScope &&
  typeof globalScope.postMessage === 'function' &&
  (typeof globalScope.importScripts === 'function' ||
    typeof globalScope.WorkerGlobalScope !== 'undefined')
) {
  const handler = new PathfinderWorkerHandler();
  globalScope.onmessage = (event: MessageEvent<WorkerMessageIn>) => {
    handler.handleMessage(event.data, (res) => {
      globalScope.postMessage(res);
    });
  };
}
