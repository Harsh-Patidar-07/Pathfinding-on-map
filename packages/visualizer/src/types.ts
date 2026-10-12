/**
 * Visualizer component types and props.\n */

import type { CSSProperties } from 'react';
import type {
  CompleteResult,
  PathfinderConnector,
  SearchAlgorithm,
  SearchStatus,
} from '@pathfinder/connector';
import type { OSMGraph } from './data/osm.js';

export interface PathfindingStats {
  visitedCount: number;
  pathCost: number;
  isRunning: boolean;
  isFound: boolean;
  status: SearchStatus;
  startNode: number | null;
  targetNode: number | null;
}

export interface PathfindingMapProps {
  /** Ingested OSM Graph representation */
  graph?: OSMGraph;
  /** Pathfinder connector bridge instance */
  connector?: PathfinderConnector;
  /** Controlled start node index */
  startNode?: number | null;
  /** Controlled target node index */
  targetNode?: number | null;
  /** Active search algorithm */
  algorithm?: SearchAlgorithm;
  /** Whether to run bidirectional frontier */
  bidirectional?: boolean;
  /** Node expansions per animation frame */
  batchSize?: number;
  /** Animation frames per second */
  fps?: number;
  /** Initial map center [longitude, latitude] */
  initialCenter?: [number, number];
  /** Initial map zoom level */
  initialZoom?: number;
  /** MapLibre GL style JSON URL or object */
  mapStyle?: string | any;
  /** Whether to hide default UI controls panel */
  hideControls?: boolean;
  /** Callback fired upon search completion */
  onSearchComplete?: (result: CompleteResult) => void;
  /** Callback fired on search stats updates */
  onStatsUpdate?: (stats: PathfindingStats) => void;
  /** Callback fired when a node is selected via map click */
  onNodeSelect?: (
    type: 'start' | 'target',
    nodeId: number,
    coord: [number, number]
  ) => void;
  /** CSS class name for container */
  className?: string;
  /** Inline style for container */
  style?: CSSProperties;
}
