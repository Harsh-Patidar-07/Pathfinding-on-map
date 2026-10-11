//! Flat road graph representation using Compressed Sparse Row (CSR) format.

use serde::{Deserialize, Serialize};

/// High-performance flat road graph with contiguous memory layout.
///
/// Contains both forward CSR representation and precomputed reverse CSR
/// for bidirectional pathfinding queries.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Graph {
    /// Number of nodes in the graph.
    pub node_count: usize,
    /// Coordinates [lat, lon] for each node in contiguous memory.
    pub nodes: Vec<[f32; 2]>,
    /// CSR row offsets for outgoing edges (length: node_count + 1).
    pub offsets: Vec<u32>,
    /// CSR column indices / target nodes for outgoing edges (length: edge_count).
    pub targets: Vec<u32>,
    /// CSR edge weights / travel distances for outgoing edges (length: edge_count).
    pub weights: Vec<f32>,

    /// Reverse CSR row offsets for incoming edges (length: node_count + 1).
    pub rev_offsets: Vec<u32>,
    /// Reverse CSR column indices / source nodes for incoming edges (length: edge_count).
    pub rev_targets: Vec<u32>,
    /// Reverse CSR edge weights (length: edge_count).
    pub rev_weights: Vec<f32>,
    /// Maps each reverse edge slot to its original forward edge index (length: edge_count).
    pub rev_edge_indices: Vec<u32>,
}

impl Graph {
    /// Constructs a graph from forward CSR components and automatically builds
    /// the reverse CSR for bidirectional queries.
    pub fn new(
        nodes: Vec<[f32; 2]>,
        offsets: Vec<u32>,
        targets: Vec<u32>,
        weights: Vec<f32>,
    ) -> Result<Self, String> {
        let node_count = nodes.len();
        if offsets.len() != node_count + 1 {
            return Err(format!(
                "Invalid offsets length: expected {}, got {}",
                node_count + 1,
                offsets.len()
            ));
        }

        let edge_count = targets.len();
        if weights.len() != edge_count {
            return Err(format!(
                "Mismatched edge weights length: targets has {}, weights has {}",
                edge_count,
                weights.len()
            ));
        }

        if offsets[0] != 0 {
            return Err(format!("offsets[0] must be 0, got {}", offsets[0]));
        }

        if offsets[node_count] as usize != edge_count {
            return Err(format!(
                "Last offset {} does not match edge count {}",
                offsets[node_count], edge_count
            ));
        }

        // Validate monotonicity and bounds
        for u in 0..node_count {
            let start = offsets[u] as usize;
            let end = offsets[u + 1] as usize;
            if start > end {
                return Err(format!(
                    "Offsets non-monotonic at node {}: {} > {}",
                    u, start, end
                ));
            }
            for e in start..end {
                let v = targets[e] as usize;
                if v >= node_count {
                    return Err(format!(
                        "Target node {} out of bounds (total nodes: {})",
                        v, node_count
                    ));
                }
                if weights[e] < 0.0 {
                    return Err(format!(
                        "Negative edge weight at index {}: {}",
                        e, weights[e]
                    ));
                }
            }
        }

        // Compute reverse CSR
        let (rev_offsets, rev_targets, rev_weights, rev_edge_indices) =
            Self::build_reverse_csr(node_count, &offsets, &targets, &weights);

        Ok(Self {
            node_count,
            nodes,
            offsets,
            targets,
            weights,
            rev_offsets,
            rev_targets,
            rev_weights,
            rev_edge_indices,
        })
    }

    /// Helper to build reverse CSR given forward graph components.
    fn build_reverse_csr(
        node_count: usize,
        offsets: &[u32],
        targets: &[u32],
        weights: &[f32],
    ) -> (Vec<u32>, Vec<u32>, Vec<f32>, Vec<u32>) {
        let edge_count = targets.len();
        let mut in_degrees = vec![0u32; node_count];
        for &v in targets {
            in_degrees[v as usize] += 1;
        }

        let mut rev_offsets = Vec::with_capacity(node_count + 1);
        rev_offsets.push(0);
        for u in 0..node_count {
            let next_off = rev_offsets[u] + in_degrees[u];
            rev_offsets.push(next_off);
        }

        let mut rev_targets = vec![0u32; edge_count];
        let mut rev_weights = vec![0.0f32; edge_count];
        let mut rev_edge_indices = vec![0u32; edge_count];
        let mut cursor = rev_offsets[0..node_count].to_vec();

        for u in 0..node_count {
            let start = offsets[u] as usize;
            let end = offsets[u + 1] as usize;
            for e in start..end {
                let v = targets[e] as usize;
                let w = weights[e];
                let slot = cursor[v] as usize;

                rev_targets[slot] = u as u32;
                rev_weights[slot] = w;
                rev_edge_indices[slot] = e as u32;

                cursor[v] += 1;
            }
        }

        (rev_offsets, rev_targets, rev_weights, rev_edge_indices)
    }

    /// Convenience constructor from raw flat coordinate arrays and CSR arrays.
    pub fn from_flat_arrays(
        flat_coords: &[f32],
        offsets: &[u32],
        targets: &[u32],
        weights: &[f32],
    ) -> Result<Self, String> {
        if flat_coords.len() % 2 != 0 {
            return Err("flat_coords length must be a multiple of 2".to_string());
        }
        let node_count = flat_coords.len() / 2;
        let mut nodes = Vec::with_capacity(node_count);
        for i in 0..node_count {
            nodes.push([flat_coords[i * 2], flat_coords[i * 2 + 1]]);
        }
        Self::new(nodes, offsets.to_vec(), targets.to_vec(), weights.to_vec())
    }

    /// Convenience builder from edge triples `(source, target, weight)`.
    /// Automatically sorts and organizes edges into CSR format.
    pub fn from_edges(nodes: Vec<[f32; 2]>, edge_triples: &[(u32, u32, f32)]) -> Self {
        let node_count = nodes.len();
        let mut sorted_edges: Vec<(u32, u32, f32)> = edge_triples.to_vec();
        // Sort by source node then target node
        sorted_edges.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.cmp(&b.1)));

        let mut offsets = Vec::with_capacity(node_count + 1);
        let mut targets = Vec::with_capacity(sorted_edges.len());
        let mut weights = Vec::with_capacity(sorted_edges.len());

        let mut current_node = 0u32;
        offsets.push(0);

        for &(src, dst, w) in &sorted_edges {
            while current_node < src {
                offsets.push(targets.len() as u32);
                current_node += 1;
            }
            targets.push(dst);
            weights.push(w);
        }

        while offsets.len() <= node_count {
            offsets.push(targets.len() as u32);
        }

        Self::new(nodes, offsets, targets, weights).expect("Valid edges generated from constructor")
    }

    /// Returns the number of nodes.
    #[inline]
    pub fn node_count(&self) -> usize {
        self.node_count
    }

    /// Returns the total number of forward edges.
    #[inline]
    pub fn edge_count(&self) -> usize {
        self.targets.len()
    }

    /// Returns the coordinates of node `u`.
    #[inline]
    pub fn node_coord(&self, u: u32) -> [f32; 2] {
        self.nodes[u as usize]
    }

    /// Returns an iterator over outgoing edges from node `u`.
    /// Yields `(target_node, weight, edge_index)`.
    #[inline]
    pub fn outgoing_edges(&self, u: u32) -> impl Iterator<Item = (u32, f32, u32)> + '_ {
        let start = self.offsets[u as usize] as usize;
        let end = self.offsets[u as usize + 1] as usize;
        (start..end).map(move |e| (self.targets[e], self.weights[e], e as u32))
    }

    /// Returns an iterator over incoming edges to node `u`.
    /// Yields `(source_node, weight, orig_forward_edge_index)`.
    #[inline]
    pub fn incoming_edges(&self, u: u32) -> impl Iterator<Item = (u32, f32, u32)> + '_ {
        let start = self.rev_offsets[u as usize] as usize;
        let end = self.rev_offsets[u as usize + 1] as usize;
        (start..end).map(move |e| {
            (
                self.rev_targets[e],
                self.rev_weights[e],
                self.rev_edge_indices[e],
            )
        })
    }

    // Pointers for zero-copy access from WebAssembly memory:

    /// Raw pointer to flat [lat, lon, lat, lon, ...] coordinates buffer.
    #[inline]
    pub fn nodes_ptr(&self) -> *const f32 {
        self.nodes.as_ptr() as *const f32
    }

    /// Number of f32 elements in the flat node coordinates buffer (2 * node_count).
    #[inline]
    pub fn nodes_len(&self) -> usize {
        self.nodes.len() * 2
    }

    /// Raw pointer to forward CSR offsets buffer.
    #[inline]
    pub fn offsets_ptr(&self) -> *const u32 {
        self.offsets.as_ptr()
    }

    /// Raw pointer to forward CSR targets buffer.
    #[inline]
    pub fn targets_ptr(&self) -> *const u32 {
        self.targets.as_ptr()
    }

    /// Raw pointer to forward CSR weights buffer.
    #[inline]
    pub fn weights_ptr(&self) -> *const f32 {
        self.weights.as_ptr()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_graph_creation_and_csr() {
        // Simple triangle: 0 -> 1 (w: 1.0), 1 -> 2 (w: 2.0), 2 -> 0 (w: 3.0), 0 -> 2 (w: 5.0)
        let nodes = vec![[0.0, 0.0], [1.0, 1.0], [2.0, 2.0]];
        let edges = vec![(0, 1, 1.0), (1, 2, 2.0), (2, 0, 3.0), (0, 2, 5.0)];
        let graph = Graph::from_edges(nodes, &edges);

        assert_eq!(graph.node_count(), 3);
        assert_eq!(graph.edge_count(), 4);

        // Outgoing from 0: targets should be 1 and 2
        let out_0: Vec<(u32, f32)> = graph.outgoing_edges(0).map(|(t, w, _)| (t, w)).collect();
        assert_eq!(out_0, vec![(1, 1.0), (2, 5.0)]);

        // Incoming to 2: sources should be 0 and 1
        let in_2: Vec<(u32, f32)> = graph.incoming_edges(2).map(|(s, w, _)| (s, w)).collect();
        assert_eq!(in_2, vec![(0, 5.0), (1, 2.0)]);
    }
}
