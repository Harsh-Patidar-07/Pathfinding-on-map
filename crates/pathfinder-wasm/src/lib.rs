//! Pathfinder-Wasm: High-performance geographic pathfinding engine.
//!
//! Provides CSR graph representation, steppable animation search execution,
//! and zero-copy linear memory buffers for WebAssembly.

pub mod astar;
pub mod bidirectional_astar;
pub mod bidirectional_dijkstra;
pub mod dijkstra;
pub mod engine;
pub mod geo;
pub mod graph;
pub mod search;

// Re-exports
pub use astar::AStar;
pub use bidirectional_astar::BidirectionalAStar;
pub use bidirectional_dijkstra::BidirectionalDijkstra;
pub use dijkstra::Dijkstra;
pub use engine::{AlgorithmType, PathfinderEngine};
pub use geo::{
    compute_heuristic, equirectangular_distance, euclidean_distance, haversine_distance,
    HeuristicType, EARTH_RADIUS_METERS,
};
pub use graph::Graph;
pub use search::{SearchStatus, SteppableSearch};
