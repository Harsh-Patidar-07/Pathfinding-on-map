//! Standard single-source Dijkstra shortest path algorithm with steppable execution.

use std::cmp::Ordering;
use std::collections::BinaryHeap;
use std::sync::Arc;

use crate::graph::Graph;
use crate::search::{SearchStatus, SteppableSearch};

#[derive(Copy, Clone, PartialEq)]
struct State {
    cost: f32,
    node: u32,
}

impl Eq for State {}

impl Ord for State {
    fn cmp(&self, other: &Self) -> Ordering {
        // Min-heap: smaller cost has higher priority
        other
            .cost
            .partial_cmp(&self.cost)
            .unwrap_or(Ordering::Equal)
    }
}

impl PartialOrd for State {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

/// Dijkstra shortest path engine with frame-by-frame steppable animation support.
pub struct Dijkstra {
    graph: Arc<Graph>,
    source: u32,
    target: u32,
    dist: Vec<f32>,
    parent: Vec<u32>,
    parent_edge: Vec<u32>,
    visited: Vec<bool>,
    pq: BinaryHeap<State>,
    status: SearchStatus,
    path_cost: Option<f32>,
    path_nodes: Vec<u32>,
    path_edges: Vec<u32>,
    explored_edges: Vec<u32>,
    newly_explored_edges: Vec<u32>,
    edge_visited: Vec<bool>,
}

impl Dijkstra {
    /// Creates a new Dijkstra search instance.
    pub fn new(graph: Arc<Graph>, source: u32, target: u32) -> Self {
        let n = graph.node_count();
        let m = graph.edge_count();
        let mut dijkstra = Self {
            graph,
            source,
            target,
            dist: vec![f32::INFINITY; n],
            parent: vec![u32::MAX; n],
            parent_edge: vec![u32::MAX; n],
            visited: vec![false; n],
            pq: BinaryHeap::new(),
            status: SearchStatus::NotStarted,
            path_cost: None,
            path_nodes: Vec::new(),
            path_edges: Vec::new(),
            explored_edges: Vec::with_capacity(m),
            newly_explored_edges: Vec::new(),
            edge_visited: vec![false; m],
        };
        dijkstra.init();
        dijkstra
    }

    fn init(&mut self) {
        let n = self.graph.node_count();
        if self.source as usize >= n || self.target as usize >= n {
            self.status = SearchStatus::NotFound;
            return;
        }

        if self.source == self.target {
            self.status = SearchStatus::Found;
            self.path_cost = Some(0.0);
            self.path_nodes = vec![self.source];
            self.path_edges = Vec::new();
            return;
        }

        self.dist[self.source as usize] = 0.0;
        self.pq.push(State {
            cost: 0.0,
            node: self.source,
        });
        self.status = SearchStatus::InProgress;
    }

    fn reconstruct_path(&mut self) {
        let mut curr = self.target;
        let mut nodes = Vec::new();
        let mut edges = Vec::new();

        nodes.push(curr);
        while curr != self.source {
            let p = self.parent[curr as usize];
            let e = self.parent_edge[curr as usize];
            if p == u32::MAX {
                // Should not happen if target was reached
                return;
            }
            edges.push(e);
            nodes.push(p);
            curr = p;
        }

        nodes.reverse();
        edges.reverse();
        self.path_nodes = nodes;
        self.path_edges = edges;
    }
}

impl SteppableSearch for Dijkstra {
    fn step(&mut self, batch_size: usize) -> SearchStatus {
        self.newly_explored_edges.clear();

        if self.status != SearchStatus::InProgress {
            return self.status;
        }

        let mut expansions = 0;
        while expansions < batch_size {
            let Some(State { cost, node: u }) = self.pq.pop() else {
                self.status = SearchStatus::NotFound;
                return self.status;
            };

            let u_idx = u as usize;
            if self.visited[u_idx] {
                continue;
            }
            self.visited[u_idx] = true;
            expansions += 1;

            if u == self.target {
                self.status = SearchStatus::Found;
                self.path_cost = Some(cost);
                self.reconstruct_path();
                return self.status;
            }

            for (v, w, edge_id) in self.graph.outgoing_edges(u) {
                let edge_idx = edge_id as usize;
                if !self.edge_visited[edge_idx] {
                    self.edge_visited[edge_idx] = true;
                    self.explored_edges.push(edge_id);
                    self.newly_explored_edges.push(edge_id);
                }

                let v_idx = v as usize;
                if self.visited[v_idx] {
                    continue;
                }

                let new_dist = cost + w;
                if new_dist < self.dist[v_idx] {
                    self.dist[v_idx] = new_dist;
                    self.parent[v_idx] = u;
                    self.parent_edge[v_idx] = edge_id;
                    self.pq.push(State {
                        cost: new_dist,
                        node: v,
                    });
                }
            }
        }

        if self.pq.is_empty() {
            self.status = SearchStatus::NotFound;
        }

        self.status
    }

    fn status(&self) -> SearchStatus {
        self.status
    }

    fn path_cost(&self) -> Option<f32> {
        self.path_cost
    }

    fn path_nodes(&self) -> &[u32] {
        &self.path_nodes
    }

    fn path_edges(&self) -> &[u32] {
        &self.path_edges
    }

    fn explored_edges(&self) -> &[u32] {
        &self.explored_edges
    }

    fn newly_explored_edges(&self) -> &[u32] {
        &self.newly_explored_edges
    }

    fn reset(&mut self, source: u32, target: u32) {
        self.source = source;
        self.target = target;
        self.dist.fill(f32::INFINITY);
        self.parent.fill(u32::MAX);
        self.parent_edge.fill(u32::MAX);
        self.visited.fill(false);
        self.pq.clear();
        self.status = SearchStatus::NotStarted;
        self.path_cost = None;
        self.path_nodes.clear();
        self.path_edges.clear();
        self.explored_edges.clear();
        self.newly_explored_edges.clear();
        self.edge_visited.fill(false);

        self.init();
    }
}
