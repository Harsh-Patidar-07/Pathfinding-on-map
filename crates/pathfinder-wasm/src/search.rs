//! Step-based pathfinding abstractions and search status tracking.

use serde::{Deserialize, Serialize};

/// Lifecycle state of a pathfinding search.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[repr(u8)]
pub enum SearchStatus {
    /// Search has not been started yet.
    #[default]
    NotStarted = 0,
    /// Search is actively running / frontier still has unvisited nodes.
    InProgress = 1,
    /// Shortest path has been found.
    Found = 2,
    /// Target is unreachable or search space exhausted.
    NotFound = 3,
}

impl SearchStatus {
    pub fn from_u8(val: u8) -> Self {
        match val {
            1 => SearchStatus::InProgress,
            2 => SearchStatus::Found,
            3 => SearchStatus::NotFound,
            _ => SearchStatus::NotStarted,
        }
    }
}

/// A step-based pathfinding search that can advance by an arbitrary batch size `N`.
///
/// Designed specifically for frame-by-frame web animation and zero-copy typed array streaming.
pub trait SteppableSearch {
    /// Advances the search by up to `batch_size` node expansions.
    /// Returns the updated `SearchStatus`.
    fn step(&mut self, batch_size: usize) -> SearchStatus;

    /// Current status of the search.
    fn status(&self) -> SearchStatus;

    /// Returns the total cost of the found shortest path, or `None` if not found.
    fn path_cost(&self) -> Option<f32>;

    /// Returns the reconstructed path as a contiguous slice of node IDs.
    fn path_nodes(&self) -> &[u32];

    /// Returns the reconstructed path as a contiguous slice of forward edge IDs.
    fn path_edges(&self) -> &[u32];

    /// Returns all explored edge IDs recorded so far.
    fn explored_edges(&self) -> &[u32];

    /// Returns the newly explored edge IDs recorded during the most recent `step()` invocation.
    fn newly_explored_edges(&self) -> &[u32];

    /// Resets the search state for new `source` and `target` node queries.
    fn reset(&mut self, source: u32, target: u32);

    /// Convenience runner that advances the search until completion or until `max_steps` is reached.
    fn run_to_completion(&mut self, max_steps: usize) -> SearchStatus {
        let mut steps = 0;
        let batch = 512;
        while self.status() == SearchStatus::InProgress || self.status() == SearchStatus::NotStarted
        {
            self.step(batch);
            steps += batch;
            if steps >= max_steps && self.status() == SearchStatus::InProgress {
                break;
            }
        }
        self.status()
    }

    // Zero-copy memory accessors:

    /// Pointer to the contiguous `explored_edges` buffer.
    fn explored_edges_ptr(&self) -> *const u32 {
        self.explored_edges().as_ptr()
    }

    /// Number of elements in the `explored_edges` buffer.
    fn explored_edges_len(&self) -> usize {
        self.explored_edges().len()
    }

    /// Pointer to the newly explored edge buffer from the last step.
    fn newly_explored_edges_ptr(&self) -> *const u32 {
        self.newly_explored_edges().as_ptr()
    }

    /// Number of elements in the newly explored edge buffer from the last step.
    fn newly_explored_edges_len(&self) -> usize {
        self.newly_explored_edges().len()
    }

    /// Pointer to the reconstructed path nodes buffer.
    fn path_nodes_ptr(&self) -> *const u32 {
        self.path_nodes().as_ptr()
    }

    /// Number of nodes in the reconstructed path.
    fn path_nodes_len(&self) -> usize {
        self.path_nodes().len()
    }

    /// Pointer to the reconstructed path edges buffer.
    fn path_edges_ptr(&self) -> *const u32 {
        self.path_edges().as_ptr()
    }

    /// Number of edges in the reconstructed path.
    fn path_edges_len(&self) -> usize {
        self.path_edges().len()
    }
}
