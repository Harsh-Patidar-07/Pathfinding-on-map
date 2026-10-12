/**
 * Phase 4 Smoke Test: End-to-End Pathfinder Development Harness
 * Live real-world road pathfinding on OpenStreetMap road topology.
 * Pipeline: User Map Click -> Real OSM Road Topology -> Wasm Web Worker Pathfinding -> Deck.gl Animation Render
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  PathfindingMap,
  getParisRoadNetwork,
  OSMGraph,
  PathfindingStats,
} from '@pathfinder/visualizer';
import {
  PathfinderConnector,
  SearchAlgorithm,
  SearchStatus,
  CompleteResult,
} from '@pathfinder/connector';
import wasmUrl from '@pathfinder/connector/wasm/pathfinder_wasm_bg.wasm?url';

// Central Paris Center & Zoom
const INITIAL_CENTER: [number, number] = [2.3415, 48.8570]; // [lon, lat] Center between Louvre & Notre-Dame
const INITIAL_ZOOM = 14.5;

// Louvre & Notre-Dame geographic coordinates for the 1-click test route
const TEST_START_COORDS: [number, number] = [48.8606, 2.3376]; // Musée du Louvre [lat, lon]
const TEST_TARGET_COORDS: [number, number] = [48.8530, 2.3499]; // Cathédrale Notre-Dame [lat, lon]

type AlgoOption = 'bi-astar' | 'astar' | 'bi-dijkstra' | 'dijkstra';

export const App: React.FC = () => {
  // Graph state: initialized immediately with REAL OpenStreetMap Paris road topology
  const [graph] = useState<OSMGraph>(() => getParisRoadNetwork());
  const statusMessage = 'Loaded 100% Real OpenStreetMap Paris Road Network (6,392 nodes • 10,829 edges)';

  // Search parameters
  const [selectedAlgoKey, setSelectedAlgoKey] = useState<AlgoOption>('bi-astar');
  const [startNode, setStartNode] = useState<number | null>(null);
  const [targetNode, setTargetNode] = useState<number | null>(null);
  const [batchSize, setBatchSize] = useState<number>(64);

  // Live telemetry readout state
  const [visitedCount, setVisitedCount] = useState<number>(0);
  const [pathLength, setPathLength] = useState<number>(-1);
  const [elapsedMs, setElapsedMs] = useState<number>(0);
  const [status, setStatus] = useState<SearchStatus>(SearchStatus.NotStarted);
  const [isRunning, setIsRunning] = useState<boolean>(false);

  const startTimeRef = useRef<number | null>(null);
  const timerIntervalRef = useRef<any>(null);

  // Map algorithm option key to engine params
  const { algorithm, bidirectional } = useMemo(() => {
    switch (selectedAlgoKey) {
      case 'dijkstra':
        return { algorithm: SearchAlgorithm.Dijkstra, bidirectional: false };
      case 'astar':
        return { algorithm: SearchAlgorithm.AStarEuclidean, bidirectional: false };
      case 'bi-dijkstra':
        return { algorithm: SearchAlgorithm.Dijkstra, bidirectional: true };
      case 'bi-astar':
      default:
        return { algorithm: SearchAlgorithm.AStarEuclidean, bidirectional: true };
    }
  }, [selectedAlgoKey]);

  // Instantiate Web Worker & Connector Bridge via workerFactory
  const connector = useMemo(() => {
    return new PathfinderConnector({
      workerFactory: () =>
        new Worker(new URL('./worker.ts', import.meta.url), {
          type: 'module',
        }),
      wasmUrl,
      defaultBatchSize: 64,
      fps: 60,
    });
  }, []);

  // Initialize connector on mount
  useEffect(() => {
    connector
      .init()
      .then(() => console.log('Pathfinder Wasm Web Worker bridge initialized'))
      .catch((err) => console.error('Failed to init connector worker:', err));

    return () => {
      connector.terminate();
    };
  }, [connector]);

  // Automatically snap initial Start (Louvre) and Target (Notre-Dame) on the real road network
  useEffect(() => {
    if (graph && graph.spatialIndex && startNode === null && targetNode === null) {
      const s = graph.spatialIndex.findNearestNode(TEST_START_COORDS[0], TEST_START_COORDS[1]);
      const t = graph.spatialIndex.findNearestNode(TEST_TARGET_COORDS[0], TEST_TARGET_COORDS[1]);
      if (s !== -1 && t !== -1) {
        setStartNode(s);
        setTargetNode(t);
      }
    }
  }, [graph, startNode, targetNode]);

  // Stop elapsed timer
  const stopTimer = useCallback(() => {
    if (timerIntervalRef.current) {
      clearInterval(timerIntervalRef.current);
      timerIntervalRef.current = null;
    }
  }, []);

  // Start elapsed timer
  const startTimer = useCallback(() => {
    stopTimer();
    const t0 = performance.now();
    startTimeRef.current = t0;
    timerIntervalRef.current = setInterval(() => {
      setElapsedMs(Math.round(performance.now() - t0));
    }, 16);
  }, [stopTimer]);

  // Master search runner: loads real road graph, resets previous search, and starts animation
  const runSearch = useCallback(
    async (sNode: number, tNode: number) => {
      if (!graph) return;
      try {
        stopTimer();
        connector.pause();
        await connector.reset();

        // 1. Ensure real OSM graph is loaded into connector
        await connector.loadGraph({
          coords: graph.nodeCoordinates,
          offsets: graph.offsets,
          targets: graph.targets,
          weights: graph.weights,
        });

        // 2. Set node coordinates and states
        setStartNode(sNode);
        setTargetNode(tNode);
        setVisitedCount(0);
        setPathLength(-1);
        setElapsedMs(0);

        // 3. Initiate Search query in Wasm Web Worker
        const initialStatus = await connector.startSearch({
          startNode: sNode,
          targetNode: tNode,
          algorithm,
          bidirectional,
        });

        setIsRunning(true);
        setStatus(initialStatus);
        startTimer();

        // 4. Start playback animation loop
        connector.play({ batchSize, fps: 60 });
      } catch (err: any) {
        console.error('Failed to run search:', err);
        setIsRunning(false);
        stopTimer();
      }
    },
    [graph, connector, algorithm, bidirectional, batchSize, stopTimer, startTimer]
  );

  // Reset search state
  const handleReset = useCallback(async () => {
    try {
      stopTimer();
      connector.pause();
      await connector.reset();
    } catch (e) {
      console.warn('Reset error:', e);
    }
    setIsRunning(false);
    setStatus(SearchStatus.NotStarted);
    setVisitedCount(0);
    setPathLength(-1);
    setElapsedMs(0);
  }, [connector, stopTimer]);

  // Run Test Route button: Snaps Louvre and Notre-Dame, executes search
  const handleRunTestRoute = useCallback(() => {
    if (!graph || !graph.spatialIndex) return;

    const snappedStart = graph.spatialIndex.findNearestNode(
      TEST_START_COORDS[0],
      TEST_START_COORDS[1]
    );
    const snappedTarget = graph.spatialIndex.findNearestNode(
      TEST_TARGET_COORDS[0],
      TEST_TARGET_COORDS[1]
    );

    if (snappedStart === -1 || snappedTarget === -1) {
      console.error('Could not find nearest road nodes for test route');
      return;
    }

    runSearch(snappedStart, snappedTarget);
  }, [graph, runSearch]);

  // Primary action button (StartStart / Pause / Resume / Restart)
  const handlePrimaryAction = useCallback(() => {
    if (isRunning) {
      // Pause active search
      connector.pause();
      setIsRunning(false);
      stopTimer();
      return;
    }

    if (status === SearchStatus.InProgress) {
      // Resume paused search
      connector.play({ batchSize, fps: 60 });
      setIsRunning(true);
      startTimer();
      return;
    }

    if (status === SearchStatus.Found || status === SearchStatus.NotFound) {
      // Restart search
      if (startNode !== null && targetNode !== null) {
        runSearch(startNode, targetNode);
      } else {
        handleRunTestRoute();
      }
      return;
    }

    // Start or Restart search
    if (startNode !== null && targetNode !== null) {
      runSearch(startNode, targetNode);
    } else {
      handleRunTestRoute();
    }
  }, [isRunning, status, startNode, targetNode, batchSize, connector, stopTimer, startTimer, runSearch, handleRunTestRoute]);

  // Search completion callback
  const handleSearchComplete = useCallback(
    (result: CompleteResult) => {
      stopTimer();
      if (startTimeRef.current !== null) {
        setElapsedMs(Math.round(performance.now() - startTimeRef.current));
      }
      setIsRunning(false);
      setStatus(result.found ? SearchStatus.Found : SearchStatus.NotFound);
      setPathLength(result.pathCost);
      setVisitedCount(result.totalVisitedEdges);
    },
    [stopTimer]
  );

  // Live stats callback from PathfinderConnector
  const handleStatsUpdate = useCallback(
    (stats: PathfindingStats) => {
      setVisitedCount(stats.visitedCount);
      setStatus(stats.status);
      if (stats.pathCost >= 0) {
        setPathLength(stats.pathCost);
      }
    },
    []
  );

  // Map click node select handler: snaps clicks to REAL OSM road nodes
  const handleNodeSelect = useCallback(
    (type: 'start' | 'target', nodeId: number) => {
      if (type === 'start') {
        setStartNode(nodeId);
        setTargetNode(null);
        setVisitedCount(0);
        setPathLength(-1);
        setStatus(SearchStatus.NotStarted);
      } else {
        setTargetNode(nodeId);
      }
    },
    []
  );

  // Distance formatter helper
  const formatDistance = (meters: number): string => {
    if (meters < 0) return '—';
    if (meters >= 1000) {
      return `${(meters / 1000).toFixed(2)} km`;
    }
    return `${Math.round(meters)} m`;
  };

  // Status badge helper
  const getStatusBadge = () => {
    switch (status) {
      case SearchStatus.InProgress:
        return { label: isRunning ? 'Running' : 'Paused', bg: isRunning ? '#0284c7' : '#f59e0b' };
      case SearchStatus.Found:
        return { label: 'Path Found', bg: '#16a34a' };
      case SearchStatus.NotFound:
        return { label: 'Not Found', bg: '#dc2626' };
      default:
        return { label: 'Ready', bg: '#475569' };
    }
  };

  const badge = getStatusBadge();

  return (
    <div
      style={{
        position: 'relative',
        width: '100vw',
        height: '100vh',
        overflow: 'hidden',
        backgroundColor: '#0f172a',
      }}
    >
      {/* Viewport Map Component */}
      <PathfindingMap
        graph={graph}
        connector={connector}
        startNode={startNode}
        targetNode={targetNode}
        algorithm={algorithm}
        bidirectional={bidirectional}
        batchSize={batchSize}
        fps={60}
        initialCenter={INITIAL_CENTER}
        initialZoom={INITIAL_ZOOM}
        hideControls={true}
        onSearchComplete={handleSearchComplete}
        onStatsUpdate={handleStatsUpdate}
        onNodeSelect={handleNodeSelect}
        style={{ width: '100%', height: '100%' }}
      />

      {/* Real OSM Roads Header Badge */}
      <div
        style={{
          position: 'absolute',
          top: 16,
          left: '50%',
          transform: 'translateX(-50%)',
          zIndex: 1000,
          backgroundColor: 'rgba(15, 23, 42, 0.94)',
          backdropFilter: 'blur(10px)',
          color: '#38bdf8',
          padding: '8px 18px',
          borderRadius: '8px',
          border: '1px solid rgba(56, 189, 248, 0.35)',
          fontSize: '12px',
          fontWeight: 600,
          display: 'flex',
          alignItems: 'center',
          gap: '10px',
          boxShadow: '0 4px 15px rgba(0, 0, 0, 0.4)',
        }}
      >
        <span style={{ display: 'inline-block', width: '8px', height: '8px', borderRadius: '50%', backgroundColor: '#22c55e' }} />
        <span>{statusMessage}</span>
      </div>

      {/* Floating Control & Telemetry Panel */}
      <div
        style={{
          position: 'absolute',
          top: 16,
          right: 16,
          zIndex: 1000,
          width: '320px',
          backgroundColor: 'rgba(15, 23, 42, 0.94)',
          backdropFilter: 'blur(14px)',
          border: '1px solid rgba(255, 255, 255, 0.14)',
          borderRadius: '12px',
          padding: '16px',
          color: '#f8fafc',
          fontFamily:
            'ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
          boxShadow: '0 12px 28px -4px rgba(0, 0, 0, 0.55)',
        }}
      >
        {/* Header */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginBottom: 8,
          }}
        >
          <div>
            <div style={{ fontWeight: 700, fontSize: '15px', letterSpacing: '-0.01em' }}>
              Paris Road PathfinderPathfinder
            </div>
            <div style={{ fontSize: '11px', color: '#94a3b8' }}>
              Real OpenStreetMapRoadTopology
            </div>
          </div>
          <span
            style={{
              fontSize: '11px',
              fontWeight: 600,
              padding: '2px 8px',
              borderRadius: '9999px',
              backgroundColor: badge.bg,
              color: '#ffffff',
              textTransform: 'uppercase',
            }}
          >
            {badge.label}
          </span>
        </div>

        {/* Real Road Graph Meta Info */}
        <div
          style={{
            fontSize: '11px',
            color: '#64748b',
            marginBottom: 12,
            paddingBottom: 8,
            borderBottom: '1px solid rgba(255, 255, 255, 0.08)',
          }}
        >
          🛣️ Real Streets: {graph.nodeCount.toLocaleString()} nodes • {graph.edgeCount.toLocaleString()} edges
        </div>

        {/* Algorithm Dropdown */}
        <div style={{ marginBottom: 12 }}>
          <label style={{ fontSize: '12px', color: '#94a3b8', display: 'block', marginBottom: 4 }}>
            Algorithm
          </label>
          <select
            value={selectedAlgoKey}
            onChange={(e) => {
              setSelectedAlgoKey(e.target.value as AlgoOption);
              handleReset();
            }}
            disabled={isRunning}
            style={{
              width: '100%',
              padding: '6px 10px',
              fontSize: '13px',
              backgroundColor: 'rgba(30, 41, 59, 0.9)',
              color: '#f8fafc',
              border: '1px solid rgba(255, 255, 255, 0.18)',
              borderRadius: '6px',
              outline: 'none',
              cursor: isRunning ? 'not-allowed' : 'pointer',
            }}
          >
            <option value="bi-astar">Bidirectional A* (Recommended)</option>
            <option value="astar">A* (Euclidean Heuristic)</option>
            <option value="bi-dijkstra">Bidirectional Dijkstra</option>
            <option value="dijkstra">Dijkstra</option>
          </select>
        </div>

        {/* Animation Batch Speed Slider */}
        <div style={{ marginBottom: 14 }}>
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              fontSize: '12px',
              color: '#94a3b8',
              marginBottom: 4,
            }}
          >
            <span>Animation Speed</span>
            <span>{batchSize} edges/frame</span>
          </div>
          <input
            type="range"
            min={1}
            max={256}
            value={batchSize}
            onChange={(e) => setBatchSize(Number(e.target.value))}
            style={{ width: '100%', accentColor: '#38bdf8' }}
          />
        </div>

        {/* Selected Points Indicator */}
        <div
          style={{
            backgroundColor: 'rgba(30, 41, 59, 0.6)',
            borderRadius: '6px',
            padding: '6px 10px',
            marginBottom: 88,
            fontSize: '11px',
            display: 'flex',
            justifyContent: 'space-between',
          }}
        >
          <div>
            <span style={{ color: '#94a3b8' }}>Start: </span>
            <span style={{ color: startNode !== null ? '#4ade80' : '#64748b', fontWeight: 600 }}>
              {startNode !== null ? `#${startNode}` : 'Click road'}
            </span>
          </div>
          <div>
            <span style={{ color: '#94a3b8' }}>Target: </span>
            <span style={{ color: targetNode !== null ? '#f87171' : '#64748b', fontWeight: 600 }}>
              {targetNode !== null ? `#${targetNode}` : 'Click road'}
            </span>
          </div>
        </div>

        {/* Interactive Prompt helper */}
        <div style={{ fontSize: '11px', color: '#94a3b8', marginBottom: 12, textAlign: 'center' }}>
          {startNode === null
            ? '📍 Click any road on the map to set Start'
            : targetNode === null
            ? '📍 Click another road to set Destination'
            : '✅ Ready! Click Start Pathfinding below'}
        </div>

        {/* Actions: Start / Pause / Resume & Reset */}
        {/* Interactive Prompt helper */}
        <div style={{ fontSize: '11px', color: '#94a3b8', marginBottom: 12, textAlign: 'center' }}>
          {startNode === null
            ? '📍 Click any road on the map to set Start'
            : targetNode === null
            ? '📍 Click another road to set Destination'
            : '✅ Ready! Click Start Pathfinding below'}
        </div>

        {/* Actions: Start / Pause / Resume & Reset */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginBottom: 14 }}>
          <div style={{ display: 'flex', gap: '8px' }}>
            <button
              onClick={handlePrimaryAction}
              
              style={{
                flex: 1,
                padding: '10px10px 14px14px',
                backgroundColor: isRunning
                  
                  ? '#f59e0b'
                  : status === SearchStatus.Found
                  ? '#16a34a'
                  : '#0284c7',
                color: '#ffffff',
                fontWeight: 700,
                fontSize: '13px',
                border: 'none',
                borderRadius: '6px',
                cursor: 'pointer',
                transition: 'background-color 0.15s ease',
              }}
            >
              {isRunning
                ? '⏸ Pause'
                : status === SearchStatus.InProgress
                ? '▶ Resume'
                : status === SearchStatus.Found || status === SearchStatus.NotFound
                ? '🔄 Restart'
                : '▶ Start Pathfinding'}
            </button>
            <button
              onClick={handleReset}
              style={{
                padding: '10px 14px',
                backgroundColor: 'rgba(51, 65, 85, 0.9)',
                color: '#e2e8f0',
                fontWeight: 500,
                fontSize: '13px',
                border: '1px solid rgba(255, 255, 255, 0.15)',
                borderRadius: '6px',
                cursor: 'pointer',
              }}
            >
              Reset
            </button>
          </div>

          <button
            onClick={handleRunTestRoute}
            disabled={isRunning}
            style={{
              padding: '7px 10px',
              backgroundColor: 'rgba(30, 41, 59, 0.8)',
              color: '#38bdf8',
              fontWeight: 600,
              fontSize: '12px',
              border: '1px solid rgba(56, 189, 248, 0.3)',
              borderRadius: '6px',
              cursor: isRunning ? 'not-allowed' : 'pointer',
            }}
          >
            ⚡ Louvre &rarr; Notre-Dame (Real Paris Route)
          </button>
        </div>

        {/* Live Readout Panel */}
        <div
          style={{
            borderTop: '1px solid rgba(255, 255, 255, 0.1)',
            paddingTop: 10,
            fontSize: '12px',
            display: 'grid',
            gridTemplateColumns: '1fr 1fr',
            gap: '8px 12px',
          }}
        >
          <div>
            <div style={{ color: '#94a3b8', fontSize: '11px' }}>Visited Edges</div>
            <div style={{ fontWeight: 700, fontSize: '14px', color: '#38bdf8' }}>
              {visitedCount.toLocaleString()}
            </div>
          </div>
          <div>
            <div style={{ color: '#94a3b8', fontSize: '11px' }}>Elapsed Time</div>
            <div style={{ fontWeight: 700, fontSize: '14px', color: '#f59e0b' }}>
              {elapsedMs} ms
            </div>
          </div>
          <div>
            <div style={{ color: '#94a3b8', fontSize: '11px' }}>Path Distance</div>
            <div style={{ fontWeight: 700, fontSize: '14px', color: '#4ade80' }}>
              {formatDistance(pathLength)}
            </div>
          </div>
          <div>
            <div style={{ color: '#94a3b8', fontSize: '11px' }}>Engine</div>
            <div style={{ fontWeight: 600, fontSize: '12px', color: '#cbd5e1' }}>
              Rust Wasm CSR
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default App;
