/**
 * Pathfinder connector types and protocol definitions.
 */

/**
 * Supported search algorithm identifiers.
 */
export enum SearchAlgorithm {
  Dijkstra = 0,
  AStarEuclidean = 1,
  AStarHaversine = 2,
}

/**
 * Search lifecycle statuses matching Rust SearchStatus enum.
 */
export enum SearchStatus {
  NotStarted = 0,
  InProgress = 1,
  Found = 2,
  NotFound = 3,
}

/**
 * Contiguous flat CSR graph buffers.
 */
export interface GraphData {
  /** Flat node coordinates [lat0, lon0, lat1, lon1, ...] */
  coords: Float32Array;
  /** CSR row offsets (length: nodeCount + 1) */
  offsets: Uint32Array;
  /** CSR target node IDs (length: edgeCount) */
  targets: Uint32Array;
  /** CSR edge travel weights/costs (length: edgeCount) */
  weights: Float32Array;
}

/**
 * Search query options.
 */
export interface SearchOptions {
  /** Starting node index */
  startNode: number;
  /** Destination node index */
  targetNode: number;
  /** Algorithm: Dijkstra, A* Euclidean, or A* Haversine */
  algorithm?: SearchAlgorithm;
  /** Use bidirectional search frontier */
  bidirectional?: boolean;
}

/**
 * Result returned after stepping the pathfinder.
 */
export interface StepResult {
  /** Current status of the search */
  status: SearchStatus;
  /** Whether search is still in progress */
  isRunning: boolean;
  /** Whether search has reached a terminal state (Found or NotFound) */
  isCompleted: boolean;
  /** Whether the shortest path was successfully found */
  isFound: boolean;
  /** Total number of explored edges so far */
  visitedEdgesCount: number;
  /** Number of newly explored edges in the last step */
  newlyVisitedEdgesCount: number;
  /** Raw byte offset in Wasm memory for visited edges buffer */
  visitedEdgesPtr: number;
  /** Raw byte offset in Wasm memory for newly visited edges buffer */
  newlyVisitedEdgesPtr: number;
  /** Raw byte offset in Wasm memory for final path node IDs buffer */
  finalPathPtr: number;
  /** Number of node IDs in the final path */
  finalPathLen: number;
  /** Raw byte offset in Wasm memory for final path edge IDs buffer */
  finalPathEdgesPtr: number;
  /** Number of edge IDs in the final path */
  finalPathEdgesLen: number;
  /** Shortest path cost/distance (-1 if not yet found) */
  pathCost: number;

  /** Zero-copy or copied TypedArray views */
  visitedEdges?: Uint32Array;
  newlyVisitedEdges?: Uint32Array;
  finalPathNodes?: Uint32Array;
  finalPathEdges?: Uint32Array;
}

/**
 * Final result emitted upon search completion.
 */
export interface CompleteResult {
  found: boolean;
  pathCost: number;
  finalPathNodes: Uint32Array;
  finalPathEdges: Uint32Array;
  totalVisitedEdges: number;
}

/**
 * Payload sent from client before assigning message ID.
 */
export type WorkerMessageInPayload =
  | {
      type: 'INIT';
      wasmBinary?: ArrayBuffer | Uint8Array;
      wasmUrl?: string;
    }
  | {
      type: 'LOAD_GRAPH';
      graph: GraphData;
    }
  | {
      type: 'START_SEARCH';
      startNode: number;
      targetNode: number;
      algorithm: number;
      bidirectional: boolean;
    }
  | {
      type: 'STEP';
      batchSize: number;
    }
  | {
      type: 'RESET';
    };

/**
 * Incoming messages from main thread to Worker.
 */
export type WorkerMessageIn = WorkerMessageInPayload & { id: number };

/**
 * Outgoing messages from Worker to main thread.
 */
export type WorkerMessageOut =
  | {
      id: number;
      type: 'INIT_OK';
    }
  | {
      id: number;
      type: 'GRAPH_LOADED';
      nodeCount: number;
      edgeCount: number;
      nodesPtr: number;
      nodesLen: number;
    }
  | {
      id: number;
      type: 'SEARCH_STARTED';
      startNode: number;
      targetNode: number;
      status: SearchStatus;
    }
  | {
      id: number;
      type: 'STEP_UPDATE';
      stepResult: StepResult;
    }
  | {
      id: number;
      type: 'RESET_OK';
    }
  | {
      id: number;
      type: 'ERROR';
      error: string;
    };
