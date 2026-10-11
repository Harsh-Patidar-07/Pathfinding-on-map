/**
 * Tests for OSM data ingestion, Overpass querying, CSR parsing, and spatial index.
 */

import {
  BoundingBox,
  buildOverpassQuery,
  getAdaptiveHighwayFilter,
  getBoundingBoxRadiusKm,
  haversineDistance,
  parseOverpassElements,
  SpatialIndex,
} from '../src/data/osm.js';

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

async function runTests() {
  console.log('🧪 Starting OSM Ingestion & Spatial Index Tests...');

  // 1. Haversine distance test
  console.log('\n--- Test 1: Haversine distance calculation ---');
  // Paris [48.8566, 2.3522] to London [51.5074, -0.1278] ~ 343 km
  const parisLondon = haversineDistance(48.8566, 2.3522, 51.5074, -0.1278);
  assert(
    Math.abs(parisLondon - 343_500) < 5_000,
    `Paris to London distance should be ~343.5km, got ${parisLondon / 1000}km`
  );
  assert(
    haversineDistance(48.8566, 2.3522, 48.8566, 2.3522) === 0,
    'Distance between identical points must be 0'
  );
  console.log(`✅ Haversine distance: ${(parisLondon / 1000).toFixed(1)} km`);

  // 2. Adaptive filtering by query radius
  console.log('\n--- Test 2: Adaptive filtering by query radius ---');
  // Small radius: 5 km
  const smallFilters = getAdaptiveHighwayFilter(5);
  assert(
    smallFilters.includes('residential') && smallFilters.includes('unclassified'),
    'Radius < 15km must include residential & unclassified'
  );

  // Medium radius: 25 km
  const medFilters = getAdaptiveHighwayFilter(25);
  assert(
    medFilters.includes('tertiary') && !medFilters.includes('residential'),
    'Radius 15-50km must include tertiary but exclude residential'
  );

  // Large radius: 75 km
  const largeFilters = getAdaptiveHighwayFilter(75);
  assert(
    !largeFilters.includes('tertiary') && largeFilters.includes('motorway'),
    'Radius > 50km must only include primary/secondary/trunk/motorway'
  );
  console.log('✅ Adaptive radius filters validated');

  // 3. Overpass query generator
  console.log('\n--- Test 3: Overpass QL query builder ---');
  const bbox: BoundingBox = [37.75, -122.45, 37.8, -122.4];
  const radiusKm = getBoundingBoxRadiusKm(bbox);
  assert(radiusKm > 0 && radiusKm < 20, `Radius should be reasonable (~6-8km), got ${radiusKm}`);

  const query = buildOverpassQuery(bbox);
  assert(query.includes('[out:json]'), 'Query must request JSON format');
  assert(query.includes('37.75,-122.45,37.8,-122.4'), 'Query must contain bounding box');
  assert(query.includes('way["highway"~'), 'Query must contain highway regex');
  console.log('✅ Overpass QL query builder validated');

  // 4. Overpass elements parsing into flat CSR
  console.log('\n--- Test 4: Parse OSM elements into Flat CSR arrays ---');
  const mockElements: any[] = [
    // Nodes
    { type: 'node', id: 101, lat: 37.77, lon: -122.42 },
    { type: 'node', id: 102, lat: 37.78, lon: -122.42 },
    { type: 'node', id: 103, lat: 37.79, lon: -122.42 },
    { type: 'node', id: 104, lat: 37.78, lon: -122.41 },
    // Unused orphan node
    { type: 'node', id: 999, lat: 37.0, lon: -122.0 },
    // Way 1 (bidirectional): 101 <-> 102 <-> 103
    {
      type: 'way',
      id: 201,
      nodes: [101, 102, 103],
      tags: { highway: 'primary' },
    },
    // Way 2 (oneway): 102 -> 104
    {
      type: 'way',
      id: 202,
      nodes: [102, 104],
      tags: { highway: 'secondary', oneway: 'yes' },
    },
  ];

  const graph = parseOverpassElements(mockElements, bbox);

  assert(graph.nodeCount === 4, `Expected 4 active nodes (excluding orphan), got ${graph.nodeCount}`);
  assert(graph.nodeCoordinates.length === 8, 'nodeCoordinates length must be 4 * 2 = 8');
  assert(graph.offsets.length === 5, 'CSR offsets length must be nodeCount + 1 = 5');
  // Edges:
  // 101 <-> 102 (2 edges)
  // 102 <-> 103 (2 edges)
  // 102 -> 104 (1 oneway edge)
  // Total edges = 5
  assert(graph.edgeCount === 5, `Expected 5 directed edges, got ${graph.edgeCount}`);
  assert(graph.targets.length === 5, 'CSR targets length must be 5');
  assert(graph.weights.length === 5, 'CSR weights length must be 5');

  for (let i = 0; i < graph.weights.length; i++) {
    assert(graph.weights[i] > 0, `Edge ${i} weight must be positive, got ${graph.weights[i]}`);
  }
  console.log(`✅ Parsed OSM graph: ${graph.nodeCount} nodes, ${graph.edgeCount} directed CSR edges`);

  // 5. Fast Spatial Index / Nearest-Neighbor Snapping
  console.log('\n--- Test 5: Spatial Index 2D Grid Nearest-Neighbor Snapping ---');
  const spatialIndex = new SpatialIndex(graph.nodeCoordinates, 16);

  // Query exactly at node 101 [37.77, -122.42] -> should return node 0
  const nearest1 = spatialIndex.findNearestNode(37.77, -122.42);
  const n1Lat = graph.nodeCoordinates[nearest1 * 2];
  const n1Lon = graph.nodeCoordinates[nearest1 * 2 + 1];
  assert(
    Math.abs(n1Lat - 37.77) < 1e-4 && Math.abs(n1Lon - -122.42) < 1e-4,
    'Exact match coordinate should snap to node 101'
  );

  // Query close to node 104 [37.78, -122.41]
  const nearest4 = spatialIndex.findNearestNode(37.7801, -122.4102);
  const n4Lat = graph.nodeCoordinates[nearest4 * 2];
  const n4Lon = graph.nodeCoordinates[nearest4 * 2 + 1];
  assert(
    Math.abs(n4Lat - 37.78) < 1e-3 && Math.abs(n4Lon - -122.41) < 1e-3,
    'Close coordinate should snap to nearest node 104'
  );
  console.log('✅ Spatial Index nearest-neighbor snapping verified');

  console.log('\n🎉 ALL PHASE 3 OSM & SPATIAL TESTS PASSED SUCCESSFULLY!');
}

runTests().catch((err) => {
  console.error('❌ Test failed with error:', err);
  process.exit(1);
});
