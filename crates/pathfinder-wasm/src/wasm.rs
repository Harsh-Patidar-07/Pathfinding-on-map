//! WasmPathfinder wasm-bindgen exports for zero-copy web worker interaction.

use std::sync::Arc;
use wasm_bindgen::prelude::*;

use crate::astar::AStar;
use crate::bidirectional_astar::BidirectionalAStar;
use crate::bidirectional_dijkstra::BidirectionalDijkstra;
use crate::dijkstra::Dijkstra;
use crate::geo::HeuristicType;
use crate::graph::Graph;
use crate::search::{SearchStatus, SteppableSearch};

/// High-level Wasm pathfinding engine bound to WebAssembly.
#[wasm_bindgen]
pub struct WasmPathfinder {
    graph: Option<Arc<Graph>>,
    search: Option<Box<dyn SteppableSearch>>,
    start_node: u32,
    target_node: u32,
}

#[wasm_bindgen]
impl WasmPathfinder {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        #[cfg(feature = "console_error_panic_hook")]
        console_error_panic_hook::set_once();

        Self {
            graph: None,
            search: None,
            start_node: 0,
            target_node: 0,
        }
    }

    /// Load graph nodes and CSR edges from raw slices.
    /// coords: flat [lat0, lon0, lat1, lon1, ...]
    /// offsets: CSR offsets (&[usize])
    /// targets: CSR targets (&[u32])
    /// weights: CSR weights (&[f32])
    pub fn load_graph(
        &mut self,
        coords: &[f32],
        offsets: &[usize],
        targets: &[u32],
        weights: &[f32],
    ) -> Result<bool, String> {
        let offsets_u32: Vec<u32> = offsets.iter().map(|&x| x as u32).collect();
        let g = Graph::from_flat_arrays(coords, &offsets_u32, targets, weights)?;
        self.graph = Some(Arc::new(g));
        self.search = None;
        Ok(true)
    }

    /// Fast path loader accepting &[u32] offsets directly without usize reallocation.
    pub fn load_graph_u32(
        &mut self,
        coords: &[f32],
        offsets: &[u32],
        targets: &[u32],
        weights: &[f32],
    ) -> Result<bool, String> {
        let g = Graph::from_flat_arrays(coords, offsets, targets, weights)?;
        self.graph = Some(Arc::new(g));
        self.search = None;
        Ok(true)
    }

    /// Initialize a search query:
    /// - algorithm: 0 = Dijkstra, 1 = A* (Euclidean), 2 = A* (Haversine)
    /// - bidirectional: true for bidirectional search, false for single-source
    pub fn start_search(
        &mut self,
        start_node: u32,
        target_node: u32,
        algorithm: u8,
        bidirectional: bool,
    ) -> Result<bool, String> {
        let graph = self
            .graph
            .as_ref()
            .ok_or_else(|| "Graph not loaded".to_string())?
            .clone();

        self.start_node = start_node;
        self.target_node = target_node;

        let heur = match algorithm {
            2 => HeuristicType::Haversine,
            1 => HeuristicType::Euclidean,
            _ => HeuristicType::Zero,
        };

        let search_box: Box<dyn SteppableSearch> = match (algorithm, bidirectional) {
            (0, false) => Box::new(Dijkstra::new(graph, start_node, target_node)),
            (0, true) => Box::new(BidirectionalDijkstra::new(graph, start_node, target_node)),
            (_, false) => Box::new(AStar::new(graph, start_node, target_node, heur)),
            (_, true) => Box::new(BidirectionalAStar::new(
                graph,
                start_node,
                target_node,
                heur,
            )),
        };

        self.search = Some(search_box);
        Ok(true)
    }

    /// Step search by `batch_size`.
    /// Returns `true` if search continues (in progress), `false` if completed (found or not found).
    pub fn step(&mut self, batch_size: u32) -> bool {
        if let Some(search) = self.search.as_mut() {
            let status = search.step(batch_size as usize);
            status == SearchStatus::InProgress
        } else {
            false
        }
    }

    /// Raw pointer to visited (explored) forward edge IDs in Wasm linear memory.
    pub fn visited_edges_ptr(&self) -> *const u32 {
        self.search
            .as_ref()
            .map(|s| s.explored_edges_ptr())
            .unwrap_or(std::ptr::null())
    }

    /// Total number of visited edges explored so far.
    pub fn visited_edges_len(&self) -> usize {
        self.search
            .as_ref()
            .map(|s| s.explored_edges_len())
            .unwrap_or(0)
    }

    /// Raw pointer to edges newly explored in the most recent `step()` invocation.
    pub fn newly_visited_edges_ptr(&self) -> *const u32 {
        self.search
            .as_ref()
            .map(|s| s.newly_explored_edges_ptr())
            .unwrap_or(std::ptr::null())
    }

    /// Number of edges newly explored in the most recent `step()` invocation.
    pub fn newly_visited_edges_len(&self) -> usize {
        self.search
            .as_ref()
            .map(|s| s.newly_explored_edges_len())
            .unwrap_or(0)
    }

    /// Raw pointer to final reconstructed path node IDs buffer.
    pub fn final_path_ptr(&self) -> *const u32 {
        self.search
            .as_ref()
            .map(|s| s.path_nodes_ptr())
            .unwrap_or(std::ptr::null())
    }

    /// Number of node IDs in final reconstructed path.
    pub fn final_path_len(&self) -> usize {
        self.search
            .as_ref()
            .map(|s| s.path_nodes_len())
            .unwrap_or(0)
    }

    /// Raw pointer to final reconstructed path edge IDs buffer.
    pub fn final_path_edges_ptr(&self) -> *const u32 {
        self.search
            .as_ref()
            .map(|s| s.path_edges_ptr())
            .unwrap_or(std::ptr::null())
    }

    /// Number of edge IDs in final reconstructed path.
    pub fn final_path_edges_len(&self) -> usize {
        self.search
            .as_ref()
            .map(|s| s.path_edges_len())
            .unwrap_or(0)
    }

    /// Shortest path distance/cost or -1.0 if not found.
    pub fn path_cost(&self) -> f32 {
        self.search
            .as_ref()
            .and_then(|s| s.path_cost())
            .unwrap_or(-1.0)
    }

    /// Returns search status code: 0 = NotStarted, 1 = InProgress, 2 = Found, 3 = NotFound.
    pub fn status(&self) -> u8 {
        self.search
            .as_ref()
            .map(|s| s.status() as u8)
            .unwrap_or(SearchStatus::NotStarted as u8)
    }

    /// Returns true if search concluded with a found path.
    pub fn is_found(&self) -> bool {
        self.status() == (SearchStatus::Found as u8)
    }

    /// Pointer to flat graph coordinates buffer [lat0, lon0, ...].
    pub fn nodes_ptr(&self) -> *const f32 {
        self.graph
            .as_ref()
            .map(|g| g.nodes_ptr())
            .unwrap_or(std::ptr::null())
    }

    pub fn nodes_len(&self) -> usize {
        self.graph.as_ref().map(|g| g.nodes_len()).unwrap_or(0)
    }

    pub fn node_count(&self) -> usize {
        self.graph.as_ref().map(|g| g.node_count()).unwrap_or(0)
    }

    pub fn edge_count(&self) -> usize {
        self.graph.as_ref().map(|g| g.edge_count()).unwrap_or(0)
    }

    /// Resets the current search query.
    pub fn reset(&mut self) -> bool {
        if let Some(search) = self.search.as_mut() {
            search.reset(self.start_node, self.target_node);
            true
        } else {
            false
        }
    }
}

impl Default for WasmPathfinder {
    fn default() -> Self {
        Self::new()
    }
}
