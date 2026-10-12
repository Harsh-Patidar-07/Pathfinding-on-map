/**
 * Integration and zero-copy memory verification test for Pathfinder connector.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  PathfinderConnector,
  PathfinderWorkerHandler,
  SearchAlgorithm,
  SearchStatus,
  GraphData,
  WorkerMessageIn,
  WorkerMessageOut,
} from '../src/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

/**
 * Builds a dummy 10-node road chain graph:
 * 0 --(1.0)--> 1 --(1.0)--> ... --(1.0)--> 9
 * Plus reverse edges to test bidirectional searches.
 */
function createDummy10NodeGraph(): GraphData {
  const nodeCount = 10;
  const coords = new Float32Array(nodeCount * 2);

  for (let i = 0; i < nodeCount; i++) {
    coords[i * 2] = i * 1.0;     // lat
    coords[i * 2 + 1] = i * 1.0; // lon
  }

  // 0 -> 1, 1 -> 0, 1 -> 2, 2 -> 1, ...
  // Total edges: 9 forward + 9 backward = 18 edges
  const edgeList: [number, number, number][] = [];
  for (let i = 0; i < nodeCount - 1; i++) {
    edgeList.push([i, i + 1, 1.0]);
    edgeList.push([i + 1, i, 1.0]);
  }

  // Sort by source node then target
  edgeList.sort((a, b) => a[0] - b[0] || a[1] - b[1]);

  const offsets = new Uint32Array(nodeCount + 1);
  const targets = new Uint32Array(edgeList.length);
  const weights = new Float32Array(edgeList.length);

  let currentSource = 0;
  offsets[0] = 0;

  for (let e = 0; e < edgeList.length; e++) {
    const [src, dst, w] = edgeList[e];
    while (currentSource < src) {
      offsets[++currentSource] = e;
    }
    targets[e] = dst;
    weights[e] = w;
  }
  while (currentSource < nodeCount) {
    offsets[++currentSource] = edgeList.length;
  }

  return { coords, offsets, targets, weights };
}

async function runTests() {
  console.log('🧪 Starting Pathfinder Connector & Wasm Memory Tests...');

  // 1. Read wasm binary from local directory
  const wasmPath = join(__dirname, '../wasm/pathfinder_wasm_bg.wasm');
  const wasmBinary = readFileSync(wasmPath);
  console.log(`📦 Loaded Wasm binary: ${wasmBinary.byteLength} bytes`);

  const graph = createDummy10NodeGraph();

  // ==========================================================================
  // Test 1: Zero-Copy Linear Memory Mapping
  // ==========================================================================
  console.log('\n--- Test 1: Zero-Copy TypedArray Reads on Wasm Linear Memory ---');
  const handler = new PathfinderWorkerHandler();
  await handler.init(wasmBinary);

  const graphInfo = handler.loadGraph(
    graph.coords,
    graph.offsets,
    graph.targets,
    graph.weights
  );
  assert(graphInfo.nodeCount === 10, 'Graph should have 10 nodes');
  assert(graphInfo.edgeCount === 18, 'Graph should have 18 edges');
  assert(graphInfo.nodesPtr > 0, 'nodesPtr should be non-zero');

  // Start search from node 0 to node 9 using Dijkstra
  const initialStatus = handler.startSearch(0, 9, SearchAlgorithm.Dijkstra, false);
  assert(initialStatus === SearchStatus.InProgress, 'Search should be in progress');

  const memoryBuffer = handler.getMemoryBuffer();
  assert(memoryBuffer !== null, 'Wasm memory buffer must be accessible');

  let stepsTaken = 0;
  let lastVisitedCount = 0;

  while (true) {
    const stepResult = handler.step(2);
    stepsTaken++;

    // Verify pointer addresses
    assert(stepResult.visitedEdgesPtr > 0, 'visitedEdgesPtr must be positive');

    // Perform direct zero-copy read from wasm memory buffer
    const zeroCopyVisited = new Uint32Array(
      memoryBuffer!,
      stepResult.visitedEdgesPtr,
      stepResult.visitedEdgesCount
    );

    assert(
      zeroCopyVisited.length === stepResult.visitedEdgesCount,
      'Zero-copy view length must match visitedEdgesCount'
    );
    assert(
      stepResult.visitedEdgesCount >= lastVisitedCount,
      'Visited edges must grow monotonically'
    );
    lastVisitedCount = stepResult.visitedEdgesCount;

    if (stepResult.isCompleted) {
      assert(stepResult.isFound, 'Search from 0 to 9 should succeed');
      assert(
        Math.abs(stepResult.pathCost - 9.0) < 1e-4,
        `Expected path cost 9.0, got ${stepResult.pathCost}`
      );

      // Verify zero-copy read of final reconstructed path
      assert(stepResult.finalPathPtr > 0, 'finalPathPtr must be positive');
      const zeroCopyPathNodes = new Uint32Array(
        memoryBuffer!,
        stepResult.finalPathPtr,
        stepResult.finalPathLen
      );
      assert(
        zeroCopyPathNodes.length === 10,
        `Expected 10 path nodes, got ${zeroCopyPathNodes.length}`
      );

      const expectedNodes = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
      for (let i = 0; i < 10; i++) {
        assert(
          zeroCopyPathNodes[i] === expectedNodes[i],
          `Path node ${i} should be ${expectedNodes[i]}, got ${zeroCopyPathNodes[i]}`
        );
      }
      console.log(`✅ Search completed in ${stepsTaken} batches! Path: ${Array.from(zeroCopyPathNodes).join(' -> ')}`);
      break;
    }
  }

  // ==========================================================================
  // Test 2: Worker Message Protocol (INIT, LOAD, START, STEP, RESET)
  // ==========================================================================
  console.log('\n--- Test 2: Worker Message Protocol (INIT, LOAD, START, STEP, RESET) ---');
  const messageWorker = new PathfinderWorkerHandler();

  const sendWorkerMessage = async (msg: WorkerMessageIn): Promise<WorkerMessageOut> => {
    let response: WorkerMessageOut | null = null;
    await messageWorker.handleMessage(msg, (res) => {
      response = res;
    });
    if (!response) {
      throw new Error(`No response received for message type ${msg.type}`);
    }
    return response;
  };

  // INIT
  const initRes = await sendWorkerMessage({ id: 1, type: 'INIT', wasmBinary });
  assert(initRes.type === 'INIT_OK', 'Worker INIT should respond INIT_OK');

  // LOAD_GRAPH
  const loadRes = await sendWorkerMessage({ id: 2, type: 'LOAD_GRAPH', graph });
  assert(loadRes.type === 'GRAPH_LOADED', 'Worker should respond GRAPH_LOADED');

  // START_SEARCH (Bidirectional A* Euclidean)
  const startRes = await sendWorkerMessage({
    id: 3,
    type: 'START_SEARCH',
    startNode: 0,
    targetNode: 9,
    algorithm: SearchAlgorithm.AStarEuclidean,
    bidirectional: true,
  });
  assert(startRes.type === 'SEARCH_STARTED', 'Worker should respond SEARCH_STARTED');

  // STEP
  const stepRes = await sendWorkerMessage({ id: 4, type: 'STEP', batchSize: 100 });
  assert(stepRes.type === 'STEP_UPDATE', 'Worker should respond STEP_UPDATE');
  if (stepRes.type === 'STEP_UPDATE') {
    const update = stepRes.stepResult;
    assert(update.isFound, 'Bidirectional A* should find path');
    assert(Math.abs(update.pathCost - 9.0) < 1e-4, 'Bidirectional A* path cost should be 9.0');
  }

  // RESET
  const resetRes = await sendWorkerMessage({ id: 5, type: 'RESET' });
  assert(resetRes.type === 'RESET_OK', 'Worker RESET should respond RESET_OK');
  console.log('✅ Worker protocol handlers passed cleanly');

  // ==========================================================================
  // Test 3: PathfinderConnector Client API & Playback
  // ==========================================================================
  console.log('\n--- Test 3: PathfinderConnector Client Bridge & Playback ---');
  const connector = new PathfinderConnector({
    wasmBinary,
    directMode: true,
    defaultBatchSize: 3,
    fps: 120,
  });

  await connector.init();
  const loadResult = await connector.loadGraph(graph);
  assert(loadResult.nodeCount === 10, 'Connector should load 10 nodes');

  let stepEventsCount = 0;
  connector.onStep((res) => {
    stepEventsCount++;
    assert(res.visitedEdgesCount > 0, 'Visited count in onStep should be > 0');
  });

  let completedResult: any = null;
  connector.onComplete((comp) => {
    completedResult = comp;
  });

  await connector.startSearch({
    startNode: 0,
    targetNode: 9,
    algorithm: SearchAlgorithm.Dijkstra,
  });

  // Playback until complete
  connector.play({ batchSize: 2, fps: 200 });
  assert(connector.isPlaying, 'Connector should report isPlaying = true');

  // Wait for playback completion
  const startTime = Date.now();
  while (!completedResult && Date.now() - startTime < 3000) {
    await new Promise((r) => setTimeout(r, 20));
  }

  assert(completedResult !== null, 'onComplete callback should have fired');
  assert(completedResult.found === true, 'Path should be found');
  assert(Math.abs(completedResult.pathCost - 9.0) < 1e-4, 'Path cost should be 9.0');
  assert(stepEventsCount > 0, 'Step listener should have fired multiple times');
  assert(!connector.isPlaying, 'Playback should automatically stop upon completion');

  // Test zero-copy view via connector getter
  const visitedView = connector.getVisitedEdgesView();
  assert(visitedView !== null && visitedView.length > 0, 'getVisitedEdgesView should return populated view');

  connector.terminate();
  console.log(`! PathfinderConnector playback passed with ${stepEventsCount} animation steps!`);

  console.log('\nALL PHASE 2 TESTS PASSED SUCCESSFULLY!');
}

runTests().catch((err) => {
  console.error('Test failed with error:', err);
  process.exit(1);
});
