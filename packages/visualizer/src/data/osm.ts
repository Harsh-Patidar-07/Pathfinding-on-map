import { PARIS_OSM_DATA } from "./paris_osm_graph.js";
/**
 * OpenStreetMap (OSM) Overpass road ingestion and flat CSR graph builder.
 */

export const EARTH_RADIUS_METERS = 6_371_000.0;

/**
 * Bounding box representation: [south, west, north, east]
 */
export type BoundingBox = [number, number, number, number];

/**
 * Computes great-circle distance between two coordinates in meters.
 */
export function haversineDistance(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  const phi1 = (lat1 * Math.PI) / 180;
  const phi2 = (lat2 * Math.PI) / 180;
  const deltaPhi = ((lat2 - lat1) * Math.PI) / 180;
  const deltaLambda = ((lon2 - lon1) * Math.PI) / 180;

  const a =
    Math.sin(deltaPhi / 2) ** 2 +
    Math.cos(phi1) * Math.cos(phi2) * Math.sin(deltaLambda / 2) ** 2;
  const clampedA = Math.min(1.0, Math.max(0.0, a));
  const c = 2 * Math.atan2(Math.sqrt(clampedA), Math.sqrt(1 - clampedA));
  return EARTH_RADIUS_METERS * c;
}

/**
 * Estimates the query radius in kilometers for a bounding box.
 */
export function getBoundingBoxRadiusKm(bbox: BoundingBox): number {
  const [south, west, north, east] = bbox;
  const centerLat = (south + north) / 2;
  const centerLon = (west + east) / 2;
  return haversineDistance(centerLat, centerLon, north, east) / 1000.0;
}

/**
 * Returns adaptive highway tag filters based on query radius:
 * - < 15 km: motorway, trunk, primary, secondary, tertiary, residential, unclassified
 * - 15 km - 50 km: motorway, trunk, primary, secondary, tertiary
 * - > 50 km: motorway, trunk, primary, secondary
 */
export function getAdaptiveHighwayFilter(radiusKm: number): string[] {
  if (radiusKm < 15) {
    return [
      'motorway',
      'trunk',
      'primary',
      'secondary',
      'tertiary',
      'residential',
      'unclassified',
    ];
  } else if (radiusKm <= 50) {
    return ['motorway', 'trunk', 'primary', 'secondary', 'tertiary'];
  } else {
    return ['motorway', 'trunk', 'primary', 'secondary'];
  }
}

/**
 * Builds an Overpass QL query string for a bounding box and highway types.
 */
export function buildOverpassQuery(
  bbox: BoundingBox,
  highwayTypes?: string[]
): string {
  const [south, west, north, east] = bbox;
  const radiusKm = getBoundingBoxRadiusKm(bbox);
  const types = highwayTypes ?? getAdaptiveHighwayFilter(radiusKm);
  const regex = `^(${types.join('|')})(_link)?$`;

  return `[out:json][timeout:35];
(
  way["highway"~"${regex}"](${south},${west},${north},${east});
);
out body;
>;
out skel qt;`;
}

/**
 * Default public Overpass API endpoints.
 */
export const DEFAULT_OVERPASS_ENDPOINTS = [
  '/api/overpass',
  'https://lz4.overpass-api.de/api/interpreter',
  'https://overpass.osm.ch/api/interpreter',
  'https://overpass-api.de/api/interpreter',
];

/**
 * Raw OSM Overpass response structure.
 */
export interface OverpassResponse {
  elements: Array<
    | {
        type: 'node';
        id: number;
        lat: number;
        lon: number;
      }
    | {
        type: 'way';
        id: number;
        nodes: number[];
        tags?: Record<string, string>;
      }
  >;
}

/**
 * Fast 2D Spatial Grid Index for nearest-neighbor lookups.
 */
export class SpatialIndex {
  private grid: number[][][]; // [gridY][gridX] -> array of node indices
  private minLat: number;
  private minLon: number;
  private maxLat: number;
  private maxLon: number;
  private cellLatSize: number;
  private cellLonSize: number;
  private cols: number;
  private rows: number;
  private coords: Float32Array;
  private nodeCount: number;

  constructor(coords: Float32Array, gridSize: number = 64) {
    this.coords = coords;
    this.nodeCount = coords.length / 2;

    if (this.nodeCount === 0) {
      this.minLat = 0;
      this.minLon = 0;
      this.maxLat = 0;
      this.maxLon = 0;
      this.cellLatSize = 1;
      this.cellLonSize = 1;
      this.cols = 1;
      this.rows = 1;
      this.grid = [[[]]];
      return;
    }

    let minLat = Infinity;
    let minLon = Infinity;
    let maxLat = -Infinity;
    let maxLon = -Infinity;

    for (let i = 0; i < this.nodeCount; i++) {
      const lat = coords[i * 2];
      const lon = coords[i * 2 + 1];
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
      if (lon < minLon) minLon = lon;
      if (lon > maxLon) maxLon = lon;
    }

    // Add small margin
    this.minLat = minLat - 0.001;
    this.maxLat = maxLat + 0.001;
    this.minLon = minLon - 0.001;
    this.maxLon = maxLon + 0.001;

    this.cols = Math.max(1, gridSize);
    this.rows = Math.max(1, gridSize);

    this.cellLatSize = (this.maxLat - this.minLat) / this.rows;
    this.cellLonSize = (this.maxLon - this.minLon) / this.cols;

    this.grid = Array.from({ length: this.rows }, () =>
      Array.from({ length: this.cols }, () => [] as number[])
    );

    // Populate grid
    for (let i = 0; i < this.nodeCount; i++) {
      const lat = coords[i * 2];
      const lon = coords[i * 2 + 1];
      const x = Math.min(
        this.cols - 1,
        Math.max(0, Math.floor((lon - this.minLon) / this.cellLonSize))
      );
      const y = Math.min(
        this.rows - 1,
        Math.max(0, Math.floor((lat - this.minLat) / this.cellLatSize))
      );
      this.grid[y][x].push(i);
    }
  }

  /**
   * Finds the closest node ID to the specified [lat, lon] coordinate.
   */
  public findNearestNode(queryLat: number, queryLon: number): number {
    if (this.nodeCount === 0) {
      return -1;
    }

    const startX = Math.min(
      this.cols - 1,
      Math.max(0, Math.floor((queryLon - this.minLon) / this.cellLonSize))
    );
    const startY = Math.min(
      this.rows - 1,
      Math.max(0, Math.floor((queryLat - this.minLat) / this.cellLatSize))
    );

    let bestNode = -1;
    let bestDist = Infinity;

    const maxRadius = Math.max(this.cols, this.rows);

    for (let r = 0; r <= maxRadius; r++) {
      let foundInRing = false;

      const yMin = Math.max(0, startY - r);
      const yMax = Math.min(this.rows - 1, startY + r);
      const xMin = Math.max(0, startX - r);
      const xMax = Math.min(this.cols - 1, startX + r);

      for (let y = yMin; y <= yMax; y++) {
        for (let x = xMin; x <= xMax; x++) {
          if (r > 0 && y > yMin && y < yMax && x > xMin && x < xMax) {
            // Interior already visited in previous radius rings
            continue;
          }

          const cellNodes = this.grid[y][x];
          for (let i = 0; i < cellNodes.length; i++) {
            const nodeIdx = cellNodes[i];
            const nLat = this.coords[nodeIdx * 2];
            const nLon = this.coords[nodeIdx * 2 + 1];
            const d = haversineDistance(queryLat, queryLon, nLat, nLon);

            if (d < bestDist) {
              bestDist = d;
              bestNode = nodeIdx;
              foundInRing = true;
            }
          }
        }
      }

      // If we found a candidate node in this ring and its distance is smaller
      // than the distance to the outer boundary of this ring, we can safely stop!
      if (foundInRing && bestNode !== -1) {
        const ringRadiusMeters =
          r * Math.min(this.cellLatSize, this.cellLonSize) * 111_000;
        if (bestDist <= ringRadiusMeters) {
          break;
        }
      }
    }

    // Fallback global check if grid boundary was missed
    if (bestNode === -1) {
      for (let i = 0; i < this.nodeCount; i++) {
        const nLat = this.coords[i * 2];
        const nLon = this.coords[i * 2 + 1];
        const d = haversineDistance(queryLat, queryLon, nLat, nLon);
        if (d < bestDist) {
          bestDist = d;
          bestNode = i;
        }
      }
    }

    return bestNode;
  }
}

/**
 * Parsed OSM Road Network Graph in flat CSR representation.
 */
export interface OSMGraph {
  /** Flat node coordinates [lat0, lon0, lat1, lon1, ...] */
  nodeCoordinates: Float32Array;
  /** CSR row offsets (length: nodeCount + 1) */
  offsets: Uint32Array;
  /** CSR target node IDs (length: edgeCount) */
  targets: Uint32Array;
  /** CSR edge weights in meters (length: edgeCount) */
  weights: Float32Array;
  /** Number of nodes in the graph */
  nodeCount: number;
  /** Number of directed edges in the graph */
  edgeCount: number;
  /** Bounding box of the ingested area [south, west, north, east] */
  bbox: BoundingBox;
  /** Fast spatial index for nearest-neighbor point snapping */
  spatialIndex: SpatialIndex;
}

/**
 * Parses raw Overpass JSON elements into flat CSR graph arrays.
 */
export function parseOverpassElements(
  elements: OverpassResponse['elements'],
  bbox: BoundingBox
): OSMGraph {
  // 1. Separate nodes and road ways
  const rawNodes = new Map<number, [number, number]>();
  const ways: Array<{ nodes: number[]; isOneway: boolean; isReverseOneway: boolean }> = [];

  for (const el of elements) {
    if (el.type === 'node') {
      rawNodes.set(el.id, [el.lat, el.lon]);
    } else if (el.type === 'way' && el.nodes && el.nodes.length >= 2) {
      const tags = el.tags || {};
      const onewayTag = tags.oneway;
      const junction = tags.junction;
      const highway = tags.highway;

      const isMotorway = highway === 'motorway';
      const isRoundabout = junction === 'roundabout';
      const isOneway =
        onewayTag === 'yes' ||
        onewayTag === '1' ||
        onewayTag === 'true' ||
        isMotorway ||
        isRoundabout;
      const isReverseOneway = onewayTag === '-1';

      ways.push({
        nodes: el.nodes,
        isOneway,
        isReverseOneway,
      });
    }
  }

  // 2. Identify only used nodes and assign compact sequential indices
  const usedNodeIds = new Set<number>();
  for (const way of ways) {
    for (const nodeId of way.nodes) {
      if (rawNodes.has(nodeId)) {
        usedNodeIds.add(nodeId);
      }
    }
  }

  const nodeMap = new Map<number, number>();
  const nodeCount = usedNodeIds.size;
  const nodeCoordinates = new Float32Array(nodeCount * 2);

  let nodeIndex = 0;
  for (const osmId of usedNodeIds) {
    const coords = rawNodes.get(osmId)!;
    nodeCoordinates[nodeIndex * 2] = coords[0];
    nodeCoordinates[nodeIndex * 2 + 1] = coords[1];
    nodeMap.set(osmId, nodeIndex);
    nodeIndex++;
  }

  // 3. Extract directed road edges
  const edgeList: [number, number, number][] = [];

  for (const way of ways) {
    const wayNodes = way.nodes;
    for (let i = 0; i < wayNodes.length - 1; i++) {
      const uOsm = wayNodes[i];
      const vOsm = wayNodes[i + 1];

      const u = nodeMap.get(uOsm);
      const v = nodeMap.get(vOsm);

      if (u === undefined || v === undefined || u === v) {
        continue;
      }

      const uLat = nodeCoordinates[u * 2];
      const uLon = nodeCoordinates[u * 2 + 1];
      const vLat = nodeCoordinates[v * 2];
      const vLon = nodeCoordinates[v * 2 + 1];

      const weight = haversineDistance(uLat, uLon, vLat, vLon);

      if (way.isReverseOneway) {
        edgeList.push([v, u, weight]);
      } else if (way.isOneway) {
        edgeList.push([u, v, weight]);
      } else {
        edgeList.push([u, v, weight]);
        edgeList.push([v, u, weight]);
      }
    }
  }

  // 4. Sort and deduplicate edges into CSR format
  edgeList.sort((a, b) => a[0] - b[0] || a[1] - b[1]);

  const uniqueEdges: [number, number, number][] = [];
  for (let i = 0; i < edgeList.length; i++) {
    const edge = edgeList[i];
    const prev = uniqueEdges[uniqueEdges.length - 1];
    if (prev && prev[0] === edge[0] && prev[1] === edge[1]) {
      // Parallel edge: keep minimum weight
      if (edge[2] < prev[2]) {
        prev[2] = edge[2];
      }
    } else {
      uniqueEdges.push(edge);
    }
  }

  const edgeCount = uniqueEdges.length;
  const offsets = new Uint32Array(nodeCount + 1);
  const targets = new Uint32Array(edgeCount);
  const weights = new Float32Array(edgeCount);

  let currentSource = 0;
  offsets[0] = 0;

  for (let e = 0; e < edgeCount; e++) {
    const [src, dst, w] = uniqueEdges[e];
    while (currentSource < src) {
      offsets[++currentSource] = e;
    }
    targets[e] = dst;
    weights[e] = w;
  }
  while (currentSource < nodeCount) {
    offsets[++currentSource] = edgeCount;
  }

  // 5. Build fast spatial index
  const spatialIndex = new SpatialIndex(nodeCoordinates);

  return {
    nodeCoordinates,
    offsets,
    targets,
    weights,
    nodeCount,
    edgeCount,
    bbox,
    spatialIndex,
  };
}

/**
 * Fetches OSM road network data via Overpass API for a given bounding box.
 */
export async function fetchOSMRoadNetwork(
  bbox: BoundingBox,
  options?: {
    endpoint?: string;
    highwayTypes?: string[];
    signal?: AbortSignal;
  }
): Promise<OSMGraph> {
  const query = buildOverpassQuery(bbox, options?.highwayTypes);
  const endpoints = options?.endpoint
    ? [options.endpoint]
    : DEFAULT_OVERPASS_ENDPOINTS;

  let lastError: Error | null = null;

  for (const endpoint of endpoints) {
    if (endpoint.startsWith('/') && typeof window === 'undefined') {
      continue;
    }
    const timeoutController = new AbortController();
    const timer = setTimeout(() => timeoutController.abort(), 6000);
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: `data=${encodeURIComponent(query)}`,
        signal: options?.signal || timeoutController.signal,
      });
      clearTimeout(timer);

      if (!response.ok) {
        throw new Error(`Overpass HTTP ${response.status}: ${response.statusText}`);
      }

      const json = (await response.json()) as OverpassResponse;
      if (!json || !json.elements) {
        throw new Error('Invalid Overpass JSON response: elements array missing');
      }

      return parseOverpassElements(json.elements, bbox);
    } catch (err: any) {
      lastError = err;
      if (options?.signal?.aborted) {
        throw err;
      }
      // Try next fallback endpoint
      continue;
    }
  }

  throw lastError ?? new Error('Failed to fetch OSM road network from Overpass API');
}

/**
 * Loads the pre-bundled real OpenStreetMap road network for Central Paris.
 * Contains 6,392 real road nodes and 10,829 directed street edges covering
 * Louvre, Seine bridges, Notre-Dame, and the Latin Quarter.
 */
export function getParisRoadNetwork(): OSMGraph {
  const spatialIndex = new SpatialIndex(PARIS_OSM_DATA.nodeCoordinates);
  return {
    nodeCoordinates: PARIS_OSM_DATA.nodeCoordinates,
    offsets: PARIS_OSM_DATA.offsets,
    targets: PARIS_OSM_DATA.targets,
    weights: PARIS_OSM_DATA.weights,
    nodeCount: PARIS_OSM_DATA.nodeCount,
    edgeCount: PARIS_OSM_DATA.edgeCount,
    bbox: PARIS_OSM_DATA.bbox,
    spatialIndex,
  };
}
