//! Bidirectional A* shortest path algorithm with consistent symmetric potentials.

use std::cmp::Ordering;
use std::collections::BinaryHeap;
use std::sync::Arc;

use crate::geo::{compute_heuristic, HeuristicType};
use crate::graph::Graph;
use crate::search::{SearchStatus, SteppableSearch};

#[derive(Copy, Clone, PartialEq)]
struct BiAStarState {
    key: f32,
    g_cost: f32,
    node: u32,
}

impl Eq for BiAStarState {}

impl Ord for BiAStarState {
    fn cmp(&self, other: &Self) -> Ordering {
        // Min-heap on key, tie-break by higher g_cost
        other
            .key
            .partial_cmp(&self.key)
            .unwrap_or(Ordering::Equal)
            .then_with(|| {
                self.g_cost
                    .partial_cmp(&other.g_cost)
                    .unwrap_or(Ordering::Equal)
            })
    }
}

impl PartialOrd for BiAStarState {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

/// Bidirectional A* pathfinding engine using consistent symmetric potentials.
pub struct BidirectionalAStar {
    graph: Arc<Graph>,
    source: u32,
    target: u32,
    heuristic: HeuristicType,
    coord_s: [f32; 2],
    coord_t: [f32; 2],

    dist_f: Vec<f32>,
    dist_b: Vec<f32>,
    parent_f: Vec<u32>,
    parent_edge_f: Vec<u32>,
    parent_b: Vec<u32>,
    parent_edge_b: Vec<u32>,
    visited_f: Vec<bool>,
    visited_b: Vec<bool>,

    pq_f: BinaryHeap<BiAStarState>,
    pq_b: BinaryHeap<BiAStarState>,

    best_cost: f32,
    best_meeting_node: Option<u32>,

    status: SearchStatus,
    path_nodes: Vec<u32>,
    path_edges: Vec<u32>,
    explored_edges: Vec<u32>,
    newly_explored_edges: Vec<u32>,
    edge_visited: Vec<bool>,
}

impl BidirectionalAStar {
    /// Creates a new Bidirectional A* search instance with consistent potential heuristic.
    pub fn new(graph: Arc<Graph>, source: u32, target: u32, heuristic: HeuristicType) -> Self {
        let n = graph.node_count();
        let m = graph.edge_count();
        let coord_s = if (source as usize) < n {
            graph.node_coord(source)
        } else {
            [0.0, 0.0]
        };
        let coord_t = if (target as usize) < n {
            graph.node_coord(target)
        } else {
            [0.0, 0.0]
        };

        let mut bi_astar = Self {
            graph,
            source,
            target,
            heuristic,
            coord_s,
            coord_t,
            dist_f: vec![f32::INFINITY; n],
            dist_b: vec![f32::INFINITY; n],
            parent_f: vec![u32::MAX; n],
            parent_edge_f: vec![u32::MAX; n],
            parent_b: vec![u32::MAX; n],
            parent_edge_b: vec![u32::MAX; n],
            visited_f: vec![false; n],
            visited_b: vec![false; n],
            pq_f: BinaryHeap::new(),
            pq_b: BinaryHeap::new(),
            best_cost: f32::INFINITY,
            best_meeting_node: None,
            status: SearchStatus::NotStarted,
            path_nodes: Vec::new(),
            path_edges: Vec::new(),
            explored_edges: Vec::with_capacity(m),
            newly_explored_edges: Vec::new(),
            edge_visited: vec![false; m],
        };
        bi_astar.init();
        bi_astar
    }

    #[inline]
    fn potential_f(&self, u: u32) -> f32 {
        let cu = self.graph.node_coord(u);
        let h_t = compute_heuristic(cu, self.coord_t, self.heuristic);
        let h_s = compute_heuristic(cu, self.coord_s, self.heuristic);
        0.5 * (h_t - h_s)
    }

    #[inline]
    fn potential_b(&self, u: u32) -> f32 {
        -self.potential_f(u)
    }

    fn init(&mut self) {
        let n = self.graph.node_count();
        if self.source as usize >= n || self.target as usize >= n {
            self.status = SearchStatus::NotFound;
            return;
        }

        self.coord_s = self.graph.node_coord(self.source);
        self.coord_t = self.graph.node_coord(self.target);

        if self.source == self.target {
            self.status = SearchStatus::Found;
            self.best_cost = 0.0;
            self.best_meeting_node = Some(self.source);
            self.path_nodes = vec![self.source];
            self.path_edges = Vec::new();
            return;
        }

        self.dist_f[self.source as usize] = 0.0;
        let p_f_s = self.potential_f(self.source);
        self.pq_f.push(BiAStarState {
            key: p_f_s,
            g_cost: 0.0,
            node: self.source,
        });

        self.dist_b[self.target as usize] = 0.0;
        let p_b_t = self.potential_b(self.target);
        self.pq_b.push(BiAStarState {
            key: p_b_t,
            g_cost: 0.0,
            node: self.target,
        });

        self.status = SearchStatus::InProgress;
    }

    fn reconstruct_path(&mut self) {
        let Some(meeting) = self.best_meeting_node else {
            return;
        };

        if self.source == self.target {
            self.path_nodes = vec![self.source];
            self.path_edges = Vec::new();
            return;
        }

        // 1. Reconstruct forward path from meeting node back to source
        let mut curr = meeting;
        let mut forward_nodes = Vec::new();
        let mut forward_edges = Vec::new();

        while curr != self.source {
            let p = self.parent_f[curr as usize];
            let e = self.parent_edge_f[curr as usize];
            if p == u32::MAX {
                break;
            }
            forward_nodes.push(curr);
            forward_edges.push(e);
            curr = p;
        }
        forward_nodes.push(self.source);
        forward_nodes.reverse();
        forward_edges.reverse();

        // 2. Reconstruct backward path from meeting node to target
        let mut curr = meeting;
        let mut backward_nodes = Vec::new();
        let mut backward_edges = Vec::new();

        while curr != self.target {
            let p = self.parent_b[curr as usize];
            let e = self.parent_edge_b[curr as usize];
            if p == u32::MAX {
                break;
            }
            backward_edges.push(e);
            backward_nodes.push(p);
            curr = p;
        }

        forward_nodes.extend(backward_nodes);
        forward_edges.extend(backward_edges);

        self.path_nodes = forward_nodes;
        self.path_edges = forward_edges;
    }
}

impl SteppableSearch for BidirectionalAStar {
    fn step(&mut self, batch_size: usize) -> SearchStatus {
        self.newly_explored_edges.clear();

        if self.status != SearchStatus::InProgress {
            return self.status;
        }

        let mut expansions = 0;

        while expansions < batch_size {
            // Check termination condition
            let min_f = self.pq_f.peek().map(|s| s.key).unwrap_or(f32::INFINITY);
            let min_b = self.pq_b.peek().map(|s| s.key).unwrap_or(f32::INFINITY);

            if self.best_meeting_node.is_some() && (min_f + min_b >= self.best_cost) {
                self.status = SearchStatus::Found;
                self.reconstruct_path();
                return self.status;
            }

            if self.pq_f.is_empty() && self.pq_b.is_empty() {
                if self.best_meeting_node.is_some() {
                    self.status = SearchStatus::Found;
                    self.reconstruct_path();
                } else {
                    self.status = SearchStatus::NotFound;
                }
                return self.status;
            }

            // Decide direction: expand the search frontier with the lower minimum key
            let expand_forward = match (self.pq_f.peek(), self.pq_b.peek()) {
                (Some(sf), Some(sb)) => sf.key <= sb.key,
                (Some(_), None) => true,
                (None, Some(_)) => false,
                (None, None) => break,
            };

            if expand_forward {
                let Some(BiAStarState {
                    g_cost, node: u, ..
                }) = self.pq_f.pop()
                else {
                    continue;
                };

                let u_idx = u as usize;
                if self.visited_f[u_idx] {
                    continue;
                }
                self.visited_f[u_idx] = true;
                expansions += 1;

                // Check meeting at u
                if self.dist_b[u_idx] < f32::INFINITY {
                    let total = g_cost + self.dist_b[u_idx];
                    if total < self.best_cost {
                        self.best_cost = total;
                        self.best_meeting_node = Some(u);
                    }
                }

                for (v, w, edge_id) in self.graph.outgoing_edges(u) {
                    let edge_idx = edge_id as usize;
                    if !self.edge_visited[edge_idx] {
                        self.edge_visited[edge_idx] = true;
                        self.explored_edges.push(edge_id);
                        self.newly_explored_edges.push(edge_id);
                    }

                    let v_idx = v as usize;
                    if self.visited_f[v_idx] {
                        continue;
                    }

                    let new_g = g_cost + w;
                    if new_g < self.dist_f[v_idx] {
                        self.dist_f[v_idx] = new_g;
                        self.parent_f[v_idx] = u;
                        self.parent_edge_f[v_idx] = edge_id;
                        let k = new_g + self.potential_f(v);
                        self.pq_f.push(BiAStarState {
                            key: k,
                            g_cost: new_g,
                            node: v,
                        });

                        if self.dist_b[v_idx] < f32::INFINITY {
                            let total = new_g + self.dist_b[v_idx];
                            if total < self.best_cost {
                                self.best_cost = total;
                                self.best_meeting_node = Some(v);
                            }
                        }
                    }
                }
            } else {
                let Some(BiAStarState {
                    g_cost, node: u, ..
                }) = self.pq_b.pop()
                else {
                    continue;
                };

                let u_idx = u as usize;
                if self.visited_b[u_idx] {
                    continue;
                }
                self.visited_b[u_idx] = true;
                expansions += 1;

                // Check meeting at u
                if self.dist_f[u_idx] < f32::INFINITY {
                    let total = g_cost + self.dist_f[u_idx];
                    if total < self.best_cost {
                        self.best_cost = total;
                        self.best_meeting_node = Some(u);
                    }
                }

                for (v, w, orig_edge_id) in self.graph.incoming_edges(u) {
                    let edge_idx = orig_edge_id as usize;
                    if !self.edge_visited[edge_idx] {
                        self.edge_visited[edge_idx] = true;
                        self.explored_edges.push(orig_edge_id);
                        self.newly_explored_edges.push(orig_edge_id);
                    }

                    let v_idx = v as usize;
                    if self.visited_b[v_idx] {
                        continue;
                    }

                    let new_g = g_cost + w;
                    if new_g < self.dist_b[v_idx] {
                        self.dist_b[v_idx] = new_g;
                        self.parent_b[v_idx] = u;
                        self.parent_edge_b[v_idx] = orig_edge_id;
                        let k = new_g + self.potential_b(v);
                        self.pq_b.push(BiAStarState {
                            key: k,
                            g_cost: new_g,
                            node: v,
                        });

                        if self.dist_f[v_idx] < f32::INFINITY {
                            let total = new_g + self.dist_f[v_idx];
                            if total < self.best_cost {
                                self.best_cost = total;
                                self.best_meeting_node = Some(v);
                            }
                        }
                    }
                }
            }
        }

        // Post-batch termination check
        if self.best_meeting_node.is_some() {
            let min_f = self.pq_f.peek().map(|s| s.key).unwrap_or(f32::INFINITY);
            let min_b = self.pq_b.peek().map(|s| s.key).unwrap_or(f32::INFINITY);
            if min_f + min_b >= self.best_cost {
                self.status = SearchStatus::Found;
                self.reconstruct_path();
                return self.status;
            }
        } else if self.pq_f.is_empty() && self.pq_b.is_empty() {
            self.status = SearchStatus::NotFound;
        }

        self.status
    }

    fn status(&self) -> SearchStatus {
        self.status
    }

    fn path_cost(&self) -> Option<f32> {
        if self.status == SearchStatus::Found {
            Some(self.best_cost)
        } else {
            None
        }
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
        self.dist_f.fill(f32::INFINITY);
        self.dist_b.fill(f32::INFINITY);
        self.parent_f.fill(u32::MAX);
        self.parent_edge_f.fill(u32::MAX);
        self.parent_b.fill(u32::MAX);
        self.parent_edge_b.fill(u32::MAX);
        self.visited_f.fill(false);
        self.visited_b.fill(false);
        self.pq_f.clear();
        self.pq_b.clear();
        self.best_cost = f32::INFINITY;
        self.best_meeting_node = None;
        self.status = SearchStatus::NotStarted;
        self.path_nodes.clear();
        self.path_edges.clear();
        self.explored_edges.clear();
        self.newly_explored_edges.clear();
        self.edge_visited.fill(false);

        self.init();
    }
}
