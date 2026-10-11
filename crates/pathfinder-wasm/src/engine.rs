//! Wasm-bindgen interface and engine coordinator for zero-copy web workers.

use std::sync::Arc;
use wasm_bindgen::prelude::*;

use crate::astar::AStar;
use crate::bidirectional_astar::BidirectionalAStar;
use crate::bidirectional_dijkstra::BidirectionalDijkstra;
use crate::dijkstra::Dijkstra;
use crate::geo::HeuristicType;
use crate::graph::Graph;
use crate::search::{SearchStatus, SteppableSearch};

/// Search algorithms supported by PathfinderEngine.
#[wasm_bindgen]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum AlgorithmType {
    Dijkstra = 0,
    AStar = 1,
    BidirectionalDijkstra = 2,
    BidirectionalAStar = 3,
}

impl AlgorithmType {
    pub fn from_u8(val: u8) -> Self {
        match val {
            1 => AlgorithmType::AStar,
            2 => AlgorithmType::BidirectionalDijkstra,
            3 => AlgorithmType::BidirectionalAStar,
            _ => AlgorithmType::Dijkstra,
        }
    }
}

/// WebAssembly-accessible pathfinding engine.
///
/// Owns the active `Graph` and `SteppableSearch` pipeline.
/// Provides direct raw pointer accessors for zero-copy TypedArray mapping in Web Workers.
#[wasm_bindgen]
pub struct PathfinderEngine {
    graph: Option<Arc<Graph>>,
    search: Option<Box<dyn SteppableSearch>>,
}

#[wasm_bindgen]
impl PathfinderEngine {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        #[cfg(feature = "console_error_panic_hook")]
        console_error_panic_hook::set_once();

        Self {
            graph: None,
            search: None,
        }
    }

    /// Loads graph topology from flat coordinate array and CSR arrays.
    pub fn load_graph(
        &mut self,
        flat_coords: &[f32],
        offsets: &[u32],
        targets: &[u32],
        weights: &[f32],
    ) -> Result<bool, String> {
        let g = Graph::from_flat_arrays(flat_coords, offsets, targets, weights)?;
        self.graph = Some(Arc::new(g));
        self.search = None;
        Ok(true)
    }

    /// Initializes a new search query.
    pub fn init_search(
        &mut self,
        algorithm: u8,
        source: u32,
        target: u32,
        heuristic: u8,
    ) -> Result<bool, String> {
        let graph = self
            .graph
            .as_ref()
            .ok_or_else(|| "Graph not loaded".to_string())?
            .clone();

        let algo_type = AlgorithmType::from_u8(algorithm);
        let heur_type = HeuristicType::from_u8(heuristic);

        let search_box: Box<dyn SteppableSearch> = match algo_type {
            AlgorithmType::Dijkstra => Box::new(Dijkstra::new(graph, source, target)),
            AlgorithmType::AStar => Box::new(AStar::new(graph, source, target, heur_type)),
            AlgorithmType::BidirectionalDijkstra => {
                Box::new(BidirectionalDijkstra::new(graph, source, target))
            }
            AlgorithmType::BidirectionalAStar => {
                Box::new(BidirectionalAStar::new(graph, source, target, heur_type))
            }
        };

        self.search = Some(search_box);
        Ok(true)
    }

    /// Advances the active search by at most `batch_size` iterations.
    /// Returns: 0 = NotStarted, 1 = InProgress, 2 = Found, 3 = NotFound.
    pub fn step(&mut self, batch_size: usize) -> u8 {
        if let Some(search) = self.search.as_mut() {
            search.step(batch_size) as u8
        } else {
            SearchStatus::NotStarted as u8
        }
    }

    /// Runs the search to completion or until `max_steps`.
    pub fn run_to_completion(&mut self, max_steps: usize) -> u8 {
        if let Some(search) = self.search.as_mut() {
            search.run_to_completion(max_steps) as u8
        } else {
            SearchStatus::NotStarted as u8
        }
    }

    /// Resets the current search with new source and target nodes.
    pub fn reset_search(&mut self, source: u32, target: u32) -> bool {
        if let Some(search) = self.search.as_mut() {
            search.reset(source, target);
            true
        } else {
            false
        }
    }

    /// Returns the current search status code.
    pub fn get_status(&self) -> u8 {
        self.search
            .as_ref()
            .map(|s| s.status() as u8)
            .unwrap_or(SearchStatus::NotStarted as u8)
    }

    /// Returns the shortest path cost or -1.0 if not found.
    pub fn get_path_cost(&self) -> f32 {
        self.search
            .as_ref()
            .and_then(|s| s.path_cost())
            .unwrap_or(-1.0)
    }

    // ------------------------------------------------------------------------
    // Zero-Copy Pointers & Buffer Dimensions (Wasm Linear Memory Bridge)
    // ------------------------------------------------------------------------

    pub fn get_nodes_ptr(&self) -> *const f32 {
        self.graph
            .as_ref()
            .map(|g| g.nodes_ptr())
            .unwrap_or(std::ptr::null())
    }

    pub fn get_nodes_len(&self) -> usize {
        self.graph.as_ref().map(|g| g.nodes_len()).unwrap_or(0)
    }

    pub fn get_node_count(&self) -> usize {
        self.graph.as_ref().map(|g| g.node_count()).unwrap_or(0)
    }

    pub fn get_edge_count(&self) -> usize {
        self.graph.as_ref().map(|g| g.edge_count()).unwrap_or(0)
    }

    pub fn get_offsets_ptr(&self) -> *const u32 {
        self.graph
            .as_ref()
            .map(|g| g.offsets_ptr())
            .unwrap_or(std::ptr::null())
    }

    pub fn get_offsets_len(&self) -> usize {
        self.graph.as_ref().map(|g| g.offsets.len()).unwrap_or(0)
    }

    pub fn get_targets_ptr(&self) -> *const u32 {
        self.graph
            .as_ref()
            .map(|g| g.targets_ptr())
            .unwrap_or(std::ptr::null())
    }

    pub fn get_targets_len(&self) -> usize {
        self.graph.as_ref().map(|g| g.targets.len()).unwrap_or(0)
    }

    pub fn get_weights_ptr(&self) -> *const f32 {
        self.graph
            .as_ref()
            .map(|g| g.weights_ptr())
            .unwrap_or(std::ptr::null())
    }

    pub fn get_weights_len(&self) -> usize {
        self.graph.as_ref().map(|g| g.weights.len()).unwrap_or(0)
    }

    pub fn get_explored_edges_ptr(&self) -> *const u32 {
        self.search
            .as_ref()
            .map(|s| s.explored_edges_ptr())
            .unwrap_or(std::ptr::null())
    }

    pub fn get_explored_edges_len(&self) -> usize {
        self.search
            .as_ref()
            .map(|s| s.explored_edges_len())
            .unwrap_or(0)
    }

    pub fn get_newly_explored_edges_ptr(&self) -> *const u32 {
        self.search
            .as_ref()
            .map(|s| s.newly_explored_edges_ptr())
            .unwrap_or(std::ptr::null())
    }

    pub fn get_newly_explored_edges_len(&self) -> usize {
        self.search
            .as_ref()
            .map(|s| s.newly_explored_edges_len())
            .unwrap_or(0)
    }

    pub fn get_path_nodes_ptr(&self) -> *const u32 {
        self.search
            .as_ref()
            .map(|s| s.path_nodes_ptr())
            .unwrap_or(std::ptr::null())
    }

    pub fn get_path_nodes_len(&self) -> usize {
        self.search
            .as_ref()
            .map(|s| s.path_nodes_len())
            .unwrap_or(0)
    }

    pub fn get_path_edges_ptr(&self) -> *const u32 {
        self.search
            .as_ref()
            .map(|s| s.path_edges_ptr())
            .unwrap_or(std::ptr::null())
    }

    pub fn get_path_edges_len(&self) -> usize {
        self.search
            .as_ref()
            .map(|s| s.path_edges_len())
            .unwrap_or(0)
    }

    // Convenience copy-out methods:

    pub fn get_path_nodes_vec(&self) -> Vec<u32> {
        self.search
            .as_ref()
            .map(|s| s.path_nodes().to_vec())
            .unwrap_or_default()
    }

    pub fn get_path_edges_vec(&self) -> Vec<u32> {
        self.search
            .as_ref()
            .map(|s| s.path_edges().to_vec())
            .unwrap_or_default()
    }

    pub fn get_explored_edges_vec(&self) -> Vec<u32> {
        self.search
            .as_ref()
            .map(|s| s.explored_edges().to_vec())
            .unwrap_or_default()
    }
}

impl Default for PathfinderEngine {
    fn default() -> Self {
        Self::new()
    }
}
