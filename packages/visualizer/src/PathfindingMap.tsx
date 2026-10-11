/**
 * PathfindingMap: Reusable MapLibre GL + Deck.gl visualizer component.
 */

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Map as MapLibreMap, NavigationControl } from 'maplibre-gl';
import { MapboxOverlay } from '@deck.gl/mapbox';
import { LineLayer, PathLayer, ScatterplotLayer } from '@deck.gl/layers';
import {
  CompleteResult,
  PathfinderConnector,
  SearchAlgorithm,
  SearchStatus,
  StepResult,
} from '@pathfinder/connector';

import { OSMGraph } from './data/osm.js';
import { PathfindingMapProps, PathfindingStats } from './types.js';

interface RoadEdge {
  id: number;
  source: [number, number]; // [lon, lat]
  target: [number, number]; // [lon, lat]
}

const DEFAULT_MAP_STYLE =
  'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json';

export const PathfindingMap: React.FC<PathfindingMapProps> = ({
  graph,
  connector: externalConnector,
  algorithm: initialAlgorithm = SearchAlgorithm.AStarEuclidean,
  bidirectional: initialBidirectional = false,
  batchSize: initialBatchSize = 64,
  fps = 60,
  initialCenter,
  initialZoom = 13,
  mapStyle = DEFAULT_MAP_STYLE,
  hideControls = false,
  onSearchComplete,
  onStatsUpdate,
  onNodeSelect,
  className,
  style,
}) => {
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const overlayRef = useRef<MapboxOverlay | null>(null);

  // Search configuration state
  const [algorithm, setAlgorithm] = useState<SearchAlgorithm>(initialAlgorithm);
  const [isBidirectional, setIsBidirectional] = useState<boolean>(initialBidirectional);
  const [batchSize, setBatchSize] = useState<number>(initialBatchSize);

  // Node selection state
  const [startNode, setStartNode] = useState<number | null>(null);
  const [targetNode, setTargetNode] = useState<number | null>(null);

  // Search progress state
  const [visitedEdgeIds, setVisitedEdgeIds] = useState<Uint32Array>(new Uint32Array(0));
  const [finalPathNodes, setFinalPathNodes] = useState<Uint32Array>(new Uint32Array(0));
  const [isPlaying, setIsPlaying] = useState<boolean>(false);
  const [searchStatus, setSearchStatus] = useState<SearchStatus>(SearchStatus.NotStarted);
  const [pathCost, setPathCost] = useState<number>(-1);

  // Internal connector instance if none provided
  const internalConnectorRef = useRef<PathfinderConnector | null>(null);
  const connector = externalConnector ?? internalConnectorRef.current;

  // 1. Initialize internal connector if needed
  useEffect(() => {
    if (!externalConnector && !internalConnectorRef.current) {
      const conn = new PathfinderConnector({
        directMode: true,
        defaultBatchSize: initialBatchSize,
        fps,
      });
      internalConnectorRef.current = conn;
      conn.init().catch((err) => console.error('Failed to init connector:', err));
    }

    return () => {
      if (internalConnectorRef.current) {
        internalConnectorRef.current.terminate();
        internalConnectorRef.current = null;
      }
    };
  }, [externalConnector, initialBatchSize, fps]);

  // 2. Precompute Road Edges for Deck.gl LineLayer
  const roadEdges: RoadEdge[] = useMemo(() => {
    if (!graph || graph.nodeCount === 0 || graph.edgeCount === 0) {
      return [];
    }

    const { offsets, targets, nodeCoordinates, nodeCount, edgeCount } = graph;
    const edges: RoadEdge[] = new Array(edgeCount);

    for (let u = 0; u < nodeCount; u++) {
      const start = offsets[u];
      const end = offsets[u + 1];
      const uLon = nodeCoordinates[u * 2 + 1];
      const uLat = nodeCoordinates[u * 2];

      for (let e = start; e < end; e++) {
        const v = targets[e];
        const vLon = nodeCoordinates[v * 2 + 1];
        const vLat = nodeCoordinates[v * 2];

        edges[e] = {
          id: e,
          source: [uLon, uLat],
          target: [vLon, vLat],
        };
      }
    }

    return edges;
  }, [graph]);

  // 3. Load graph into connector when available
  useEffect(() => {
    if (!connector || !graph || graph.nodeCount === 0) return;

    connector
      .loadGraph({
        coords: graph.nodeCoordinates,
        offsets: graph.offsets,
        targets: graph.targets,
        weights: graph.weights,
      })
      .then(() => {
        // Automatically default start and target to first and last node if not set
        if (startNode === null && targetNode === null && graph.nodeCount >= 2) {
          setStartNode(0);
          setTargetNode(graph.nodeCount - 1);
        }
      })
      .catch((err) => console.error('Error loading graph into connector:', err));
  }, [connector, graph]);

  // 4. Initialize MapLibre GL & Deck.gl Overlay
  useEffect(() => {
    if (!mapContainerRef.current || mapRef.current) return;

    let center: [number, number] = initialCenter ?? [0, 0];
    if (!initialCenter && graph && graph.nodeCount > 0) {
      // Use center of graph bbox
      const [south, west, north, east] = graph.bbox;
      center = [(west + east) / 2, (south + north) / 2];
    }

    const map = new MapLibreMap({
      container: mapContainerRef.current,
      style: mapStyle,
      center,
      zoom: initialZoom,
      attributionControl: false,
    });

    map.addControl(new NavigationControl({ showCompass: true }), 'top-left');

    const overlay = new MapboxOverlay({
      interleaved: false,
      layers: [],
    });

    map.addControl(overlay as any);

    mapRef.current = map;
    overlayRef.current = overlay;

    // Map Click Listener to select Start / Target nodes via Spatial Index
    map.on('click', (e) => {
      if (!graph || !graph.spatialIndex) return;
      const clickedLat = e.lngLat.lat;
      const clickedLon = e.lngLat.lng;

      const nearestNode = graph.spatialIndex.findNearestNode(
        clickedLat,
        clickedLon
      );
      if (nearestNode === -1) return;

      const nodeLat = graph.nodeCoordinates[nearestNode * 2];
      const nodeLon = graph.nodeCoordinates[nearestNode * 2 + 1];

      // Alternate selection or restart
      setStartNode((prevStart) => {
        if (prevStart === null || (targetNode !== null && searchStatus === SearchStatus.Found)) {
          // Setting new start
          setTargetNode(null);
          setVisitedEdgeIds(new Uint32Array(0));
          setFinalPathNodes(new Uint32Array(0));
          setSearchStatus(SearchStatus.NotStarted);
          setPathCost(-1);
          onNodeSelect?.('start', nearestNode, [nodeLat, nodeLon]);
          return nearestNode;
        } else {
          // Setting target
          setTargetNode(nearestNode);
          onNodeSelect?.('target', nearestNode, [nodeLat, nodeLon]);
          return prevStart;
        }
      });
    });

    return () => {
      if (overlayRef.current && mapRef.current) {
        mapRef.current.removeControl(overlayRef.current as any);
      }
      map.remove();
      mapRef.current = null;
      overlayRef.current = null;
    };
  }, []);

  // Update map center when graph bbox changes
  useEffect(() => {
    if (!mapRef.current || !graph || graph.nodeCount === 0) return;
    const [south, west, north, east] = graph.bbox;
    mapRef.current.fitBounds(
      [
        [west, south],
        [east, north],
      ],
      { padding: 40, duration: 1000 }
    );
  }, [graph?.bbox]);

  // 5. Build and Update Deck.gl Layers
  useEffect(() => {
    if (!overlayRef.current || !graph) return;

    const layers: any[] = [];

    // Layer A: Base Road Network (subtle semi-transparent lines)
    if (roadEdges.length > 0) {
      layers.push(
        new LineLayer<RoadEdge>({
          id: 'base-road-network',
          data: roadEdges,
          getSourcePosition: (d: RoadEdge) => d.source,
          getTargetPosition: (d: RoadEdge) => d.target,
          getColor: [90, 110, 135, 75],
          getWidth: 1.5,
          widthUnits: 'pixels',
          pickable: false,
        })
      );
    }

    // Layer B: Visited / Frontier Edges (vibrant cyan animation)
    if (visitedEdgeIds.length > 0 && roadEdges.length > 0) {
      layers.push(
        new LineLayer<number>({
          id: 'visited-edges',
          data: Array.from(visitedEdgeIds),
          getSourcePosition: (e: number) => roadEdges[e]?.source ?? [0, 0],
          getTargetPosition: (e: number) => roadEdges[e]?.target ?? [0, 0],
          getColor: [0, 220, 255, 200],
          getWidth: 3,
          widthUnits: 'pixels',
          pickable: false,
        })
      );
    }

    // Layer C: Final Shortest Path Line (outer glow + glowing route line)
    if (finalPathNodes.length >= 2) {
      const pathCoords: [number, number][] = [];
      for (let i = 0; i < finalPathNodes.length; i++) {
        const idx = finalPathNodes[i];
        pathCoords.push([
          graph.nodeCoordinates[idx * 2 + 1],
          graph.nodeCoordinates[idx * 2],
        ]);
      }

      layers.push(
        new PathLayer({
          id: 'final-path-glow',
          data: [{ path: pathCoords }],
          getPath: (d: any) => d.path,
          getColor: [0, 255, 128, 85],
          getWidth: 12,
          widthUnits: 'pixels',
          capRounded: true,
          jointRounded: true,
        }),
        new PathLayer({
          id: 'final-path-core',
          data: [{ path: pathCoords }],
          getPath: (d: any) => d.path,
          getColor: [0, 255, 136, 255],
          getWidth: 4.5,
          widthUnits: 'pixels',
          capRounded: true,
          jointRounded: true,
        })
      );
    }

    // Layer D: Markers for Start & Target Points
    const markers: Array<{
      position: [number, number];
      color: [number, number, number, number];
      radius: number;
    }> = [];

    if (startNode !== null && startNode < graph.nodeCount) {
      const startCoord: [number, number] = [
        graph.nodeCoordinates[startNode * 2 + 1],
        graph.nodeCoordinates[startNode * 2],
      ];
      // Outer ring
      markers.push({
        position: startCoord,
        color: [0, 230, 118, 90],
        radius: 14,
      });
      // Inner circle
      markers.push({
        position: startCoord,
        color: [0, 230, 118, 255],
        radius: 7,
      });
    }

    if (targetNode !== null && targetNode < graph.nodeCount) {
      const targetCoord: [number, number] = [
        graph.nodeCoordinates[targetNode * 2 + 1],
        graph.nodeCoordinates[targetNode * 2],
      ];
      // Outer ring
      markers.push({
        position: targetCoord,
        color: [255, 61, 0, 90],
        radius: 14,
      });
      // Inner circle
      markers.push({
        position: targetCoord,
        color: [255, 61, 0, 255],
        radius: 7,
      });
    }

    if (markers.length > 0) {
      layers.push(
        new ScatterplotLayer({
          id: 'start-target-markers',
          data: markers,
          getPosition: (d: any) => d.position,
          getFillColor: (d: any) => d.color,
          getLineColor: [255, 255, 255, 240],
          stroked: true,
          lineWidthMinPixels: 1.5,
          getRadius: (d: any) => d.radius,
          radiusUnits: 'pixels',
          pickable: false,
        })
      );
    }

    overlayRef.current.setProps({ layers });
  }, [graph, roadEdges, visitedEdgeIds, finalPathNodes, startNode, targetNode]);

  // 6. Connect to PathfinderConnector events
  useEffect(() => {
    if (!connector) return;

    const unsubStep = connector.onStep((res: StepResult) => {
      if (res.visitedEdges) {
        setVisitedEdgeIds(res.visitedEdges);
      }
      setSearchStatus(res.status);
      setPathCost(res.pathCost);

      const stats: PathfindingStats = {
        visitedCount: res.visitedEdgesCount,
        pathCost: res.pathCost,
        isRunning: res.isRunning,
        isFound: res.isFound,
        status: res.status,
        startNode,
        targetNode,
      };
      onStatsUpdate?.(stats);
    });

    const unsubComplete = connector.onComplete((comp: CompleteResult) => {
      setFinalPathNodes(comp.finalPathNodes);
      setIsPlaying(false);
      onSearchComplete?.(comp);
    });

    return () => {
      unsubStep();
      unsubComplete();
    };
  }, [connector, startNode, targetNode, onStatsUpdate, onSearchComplete]);

  // 7. Playback Actions
  const handleStartOrResume = useCallback(async () => {
    if (!connector || startNode === null || targetNode === null) return;

    if (searchStatus === SearchStatus.NotStarted) {
      setVisitedEdgeIds(new Uint32Array(0));
      setFinalPathNodes(new Uint32Array(0));
      await connector.startSearch({
        startNode,
        targetNode,
        algorithm,
        bidirectional: isBidirectional,
      });
    }

    connector.play({ batchSize, fps });
    setIsPlaying(true);
  }, [connector, startNode, targetNode, algorithm, isBidirectional, batchSize, fps, searchStatus]);

  const handlePause = useCallback(() => {
    if (!connector) return;
    connector.pause();
    setIsPlaying(false);
  }, [connector]);

  const handleStepOnce = useCallback(async () => {
    if (!connector || startNode === null || targetNode === null) return;

    if (searchStatus === SearchStatus.NotStarted) {
      setVisitedEdgeIds(new Uint32Array(0));
      setFinalPathNodes(new Uint32Array(0));
      await connector.startSearch({
        startNode,
        targetNode,
        algorithm,
        bidirectional: isBidirectional,
      });
    }

    await connector.step(batchSize);
  }, [connector, startNode, targetNode, algorithm, isBidirectional, batchSize, searchStatus]);

  const handleReset = useCallback(async () => {
    if (!connector) return;
    connector.pause();
    setIsPlaying(false);
    await connector.reset();
    setVisitedEdgeIds(new Uint32Array(0));
    setFinalPathNodes(new Uint32Array(0));
    setSearchStatus(SearchStatus.NotStarted);
    setPathCost(-1);
  }, [connector]);

  const formatDistance = (meters: number): string => {
    if (meters < 0) return '—';
    if (meters >= 1000) {
      return `${(meters / 1000).toFixed(2)} km`;
    }
    return `${Math.round(meters)} m`;
  };

  const getStatusBadge = () => {
    switch (searchStatus) {
      case SearchStatus.InProgress:
        return { label: 'In Progress', bg: '#0284c7' };
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
      className={className}
      style={{
        position: 'relative',
        width: '100%',
        height: '100%',
        minHeight: '400px',
        overflow: 'hidden',
        ...style,
      }}
    >
      {/* MapLibre Map Container */}
      <div
        ref={mapContainerRef}
        style={{
          width: '100%',
          height: '100%',
          position: 'absolute',
          top: 0,
          left: 0,
        }}
      />

      {/* Modern HUD Controls Overlay */}
      {!hideControls && (
        <div
          style={{
            position: 'absolute',
            top: 16,
            right: 16,
            zIndex: 10,
            width: '320px',
            backgroundColor: 'rgba(15, 23, 42, 0.88)',
            backdropFilter: 'blur(12px)',
            border: '1px solid rgba(255, 255, 255, 0.12)',
            borderRadius: '12px',
            padding: '16px',
            color: '#f8fafc',
            fontFamily:
              'ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
            boxShadow: '0 10px 25px -5px rgba(0, 0, 0, 0.5)',
          }}
        >
          {/* Header & Status Badge */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              marginBottom: 12,
            }}
          >
            <span style={{ fontWeight: 700, fontSize: '15px', letterSpacing: '-0.01em' }}>
              Pathfinder Engine
            </span>
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

          {/* Algorithm Selection */}
          <div style={{ marginBottom: 10 }}>
            <label style={{ fontSize: '12px', color: '#94a3b8', display: 'block', marginBottom: 4 }}>
              Algorithm
            </label>
            <select
              value={`${algorithm}:${isBidirectional}`}
              onChange={(e) => {
                const [algo, bi] = e.target.value.split(':');
                setAlgorithm(Number(algo));
                setIsBidirectional(bi === 'true');
                handleReset();
              }}
              style={{
                width: '100%',
                padding: '6px 10px',
                fontSize: '13px',
                backgroundColor: 'rgba(30, 41, 59, 0.8)',
                color: '#f8fafc',
                border: '1px solid rgba(255, 255, 255, 0.15)',
                borderRadius: '6px',
                outline: 'none',
              }}
            >
              <option value={`${SearchAlgorithm.Dijkstra}:false`}>Dijkstra</option>
              <option value={`${SearchAlgorithm.AStarEuclidean}:false`}>A* (Euclidean)</option>
              <option value={`${SearchAlgorithm.AStarHaversine}:false`}>A* (Haversine)</option>
              <option value={`${SearchAlgorithm.Dijkstra}:true`}>Bidirectional Dijkstra</option>
              <option value={`${SearchAlgorithm.AStarEuclidean}:true`}>Bidirectional A* (Euclidean)</option>
              <option value={`${SearchAlgorithm.AStarHaversine}:true`}>Bidirectional A* (Haversine)</option>
            </select>
          </div>

          {/* Batch Size (Nodes per frame) Slider */}
          <div style={{ marginBottom: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', color: '#94a3b8', marginBottom: 4 }}>
              <span>Batch Speed</span>
              <span>{batchSize} nodes/frame</span>
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

          {/* Play / Step / Reset Action Buttons */}
          <div style={{ display: 'flex', gap: '8px', marginBottom: 14 }}>
            {isPlaying ? (
              <button
                onClick={handlePause}
                style={{
                  flex: 1,
                  padding: '7px 12px',
                  backgroundColor: '#f59e0b',
                  color: '#000000',
                  fontWeight: 600,
                  fontSize: '13px',
                  border: 'none',
                  borderRadius: '6px',
                  cursor: 'pointer',
                }}
              >
                ⏸ Pause
              </button>
            ) : (
              <button
                onClick={handleStartOrResume}
                disabled={startNode === null || targetNode === null}
                style={{
                  flex: 1,
                  padding: '7px 12px',
                  backgroundColor: startNode !== null && targetNode !== null ? '#38bdf8' : '#334155',
                  color: startNode !== null && targetNode !== null ? '#0f172a' : '#64748b',
                  fontWeight: 600,
                  fontSize: '13px',
                  border: 'none',
                  borderRadius: '6px',
                  cursor: startNode !== null && targetNode !== null ? 'pointer' : 'not-allowed',
                }}
              >
                ▶ Play
              </button>
            )}

            <button
              onClick={handleStepOnce}
              disabled={isPlaying || startNode === null || targetNode === null}
              style={{
                padding: '7px 12px',
                backgroundColor: 'rgba(51, 65, 85, 0.8)',
                color: '#f8fafc',
                fontSize: '13px',
                border: '1px solid rgba(255, 255, 255, 0.1)',
                borderRadius: '6px',
                cursor: 'pointer',
              }}
            >
              ⏭ Step
            </button>

            <button
              onClick={handleReset}
              style={{
                padding: '7px 12px',
                backgroundColor: 'rgba(51, 65, 85, 0.8)',
                color: '#f8fafc',
                fontSize: '13px',
                border: '1px solid rgba(255, 255, 255, 0.1)',
                borderRadius: '6px',
                cursor: 'pointer',
              }}
            >
              🔄 Reset
            </button>
          </div>

          {/* Real-time Stats Grid */}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '1fr 1fr',
              gap: '8px',
              padding: '10px',
              backgroundColor: 'rgba(15, 23, 42, 0.6)',
              borderRadius: '8px',
              fontSize: '12px',
              border: '1px solid rgba(255, 255, 255, 0.05)',
            }}
          >
            <div>
              <span style={{ color: '#94a3b8', display: 'block' }}>Explored Edges</span>
              <span style={{ fontWeight: 600, color: '#38bdf8' }}>
                {visitedEdgeIds.length.toLocaleString()}
              </span>
            </div>
            <div>
              <span style={{ color: '#94a3b8', display: 'block' }}>Shortest Distance</span>
              <span style={{ fontWeight: 600, color: '#4ade80' }}>
                {formatDistance(pathCost)}
              </span>
            </div>
            <div>
              <span style={{ color: '#94a3b8', display: 'block' }}>Start Node</span>
              <span style={{ fontWeight: 500, color: '#f8fafc' }}>
                {startNode !== null ? `#${startNode}` : 'Not set'}
              </span>
            </div>
            <div>
              <span style={{ color: '#94a3b8', display: 'block' }}>Target Node</span>
              <span style={{ fontWeight: 500, color: '#f8fafc' }}>
                {targetNode !== null ? `#${targetNode}` : 'Not set'}
              </span>
            </div>
          </div>

          {/* Interactive Hint */}
          <div
            style={{
              marginTop: 10,
              fontSize: '11px',
              color: '#64748b',
              textAlign: 'center',
            }}
          >
            💡 Click on map to place Start 🟢 & Target 🔴 points
          </div>
        </div>
      )}
    </div>
  );
};

export default PathfindingMap;
