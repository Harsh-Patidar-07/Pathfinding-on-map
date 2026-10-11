use std::sync::Arc;

use pathfinder_wasm::{
    haversine_distance, AStar, AlgorithmType, BidirectionalAStar, BidirectionalDijkstra, Dijkstra,
    Graph, HeuristicType, PathfinderEngine, SearchStatus, SteppableSearch,
};

/// Helper to build a 2D grid graph of size `width` x `height`.
/// Coordinates are [y as f32, x as f32].
/// Edges are 4-connected bidirectional with Euclidean weight 1.0.
fn create_grid_graph(width: usize, height: usize) -> Arc<Graph> {
    let node_count = width * height;
    let mut nodes = Vec::with_capacity(node_count);

    for y in 0..height {
        for x in 0..width {
            nodes.push([y as f32, x as f32]);
        }
    }

    let mut edges = Vec::new();

    for y in 0..height {
        for x in 0..width {
            let u = (y * width + x) as u32;

            // Right
            if x + 1 < width {
                let v = (y * width + (x + 1)) as u32;
                edges.push((u, v, 1.0));
                edges.push((v, u, 1.0));
            }

            // Down
            if y + 1 < height {
                let v = ((y + 1) * width + x) as u32;
                edges.push((u, v, 1.0));
                edges.push((v, u, 1.0));
            }
        }
    }

    Arc::new(Graph::from_edges(nodes, &edges))
}

/// Helper to verify path continuity: each consecutive node pair in path_nodes
/// must match the corresponding edge in path_edges.
fn verify_path_continuity(
    graph: &Graph,
    path_nodes: &[u32],
    path_edges: &[u32],
    expected_cost: f32,
) {
    assert!(
        !path_nodes.is_empty(),
        "Path nodes should not be empty on successful search"
    );

    if path_nodes.len() == 1 {
        assert!(path_edges.is_empty());
        assert_eq!(expected_cost, 0.0);
        return;
    }

    assert_eq!(
        path_nodes.len() - 1,
        path_edges.len(),
        "Path edges count must be path_nodes.len() - 1"
    );

    let mut accumulated_cost = 0.0;

    for i in 0..path_edges.len() {
        let u = path_nodes[i];
        let v = path_nodes[i + 1];
        let edge_id = path_edges[i] as usize;

        // Verify edge targets and weights from CSR
        let target = graph.targets[edge_id];
        let weight = graph.weights[edge_id];

        assert_eq!(target, v, "Edge {} should target node {}", edge_id, v);

        // Verify edge actually originates from u
        let u_start = graph.offsets[u as usize] as usize;
        let u_end = graph.offsets[u as usize + 1] as usize;
        assert!(
            (u_start..u_end).contains(&edge_id),
            "Edge {} must be in outgoing slice of node {}",
            edge_id,
            u
        );

        accumulated_cost += weight;
    }

    assert!(
        (accumulated_cost - expected_cost).abs() < 1e-4,
        "Accumulated cost {} did not match expected {}",
        accumulated_cost,
        expected_cost
    );
}

#[test]
fn test_all_four_searches_on_grid() {
    let graph = create_grid_graph(5, 5); // 25 nodes: (0,0) to (4,4)
    let source = 0u32;
    let target = 24u32;
    let expected_cost = 8.0f32; // Manhattan distance on 5x5 grid

    // 1. Dijkstra with small batch stepping
    {
        let mut search = Dijkstra::new(graph.clone(), source, target);
        while search.status() == SearchStatus::InProgress {
            search.step(2);
        }
        assert_eq!(search.status(), SearchStatus::Found);
        assert_eq!(search.path_cost(), Some(expected_cost));
        verify_path_continuity(
            &graph,
            search.path_nodes(),
            search.path_edges(),
            expected_cost,
        );
        assert!(!search.explored_edges().is_empty());
    }

    // 2. A* (Euclidean heuristic)
    {
        let mut search = AStar::new(graph.clone(), source, target, HeuristicType::Euclidean);
        while search.status() == SearchStatus::InProgress {
            search.step(3);
        }
        assert_eq!(search.status(), SearchStatus::Found);
        assert_eq!(search.path_cost(), Some(expected_cost));
        verify_path_continuity(
            &graph,
            search.path_nodes(),
            search.path_edges(),
            expected_cost,
        );
        assert!(!search.explored_edges().is_empty());
    }

    // 3. Bidirectional Dijkstra
    {
        let mut search = BidirectionalDijkstra::new(graph.clone(), source, target);
        while search.status() == SearchStatus::InProgress {
            search.step(2);
        }
        assert_eq!(search.status(), SearchStatus::Found);
        assert_eq!(search.path_cost(), Some(expected_cost));
        verify_path_continuity(
            &graph,
            search.path_nodes(),
            search.path_edges(),
            expected_cost,
        );
        assert!(!search.explored_edges().is_empty());
    }

    // 4. Bidirectional A* (Euclidean heuristic)
    {
        let mut search =
            BidirectionalAStar::new(graph.clone(), source, target, HeuristicType::Euclidean);
        while search.status() == SearchStatus::InProgress {
            search.step(2);
        }
        assert_eq!(search.status(), SearchStatus::Found);
        assert_eq!(search.path_cost(), Some(expected_cost));
        verify_path_continuity(
            &graph,
            search.path_nodes(),
            search.path_edges(),
            expected_cost,
        );
        assert!(!search.explored_edges().is_empty());
    }
}

#[test]
fn test_asymmetric_directed_graph_with_one_way_streets() {
    // 6 nodes:
    // 0 -> 1 (w: 10.0)
    // 0 -> 2 (w: 2.0)
    // 2 -> 3 (w: 2.0)
    // 3 -> 4 (w: 2.0)
    // 4 -> 5 (w: 2.0)  => Path 0 -> 2 -> 3 -> 4 -> 5 total = 8.0
    // 1 -> 5 (w: 1.0)   => Path 0 -> 1 -> 5 total = 11.0
    // Plus a dead-end: 2 -> 1 (one-way w: 100.0)
    let nodes = vec![
        [0.0, 0.0], // 0
        [5.0, 0.0], // 1
        [1.0, 1.0], // 2
        [2.0, 2.0], // 3
        [3.0, 3.0], // 4
        [5.0, 5.0], // 5
    ];

    let edges = vec![
        (0, 1, 10.0),
        (0, 2, 2.0),
        (2, 3, 2.0),
        (3, 4, 2.0),
        (4, 5, 2.0),
        (1, 5, 1.0),
        (2, 1, 100.0),
    ];

    let graph = Arc::new(Graph::from_edges(nodes, &edges));
    let source = 0;
    let target = 5;
    let expected_cost = 8.0f32;

    // Dijkstra
    let mut d = Dijkstra::new(graph.clone(), source, target);
    assert_eq!(d.run_to_completion(100), SearchStatus::Found);
    assert_eq!(d.path_cost(), Some(expected_cost));
    verify_path_continuity(&graph, d.path_nodes(), d.path_edges(), expected_cost);

    // A* (Zero)
    let mut a0 = AStar::new(graph.clone(), source, target, HeuristicType::Zero);
    assert_eq!(a0.run_to_completion(100), SearchStatus::Found);
    assert_eq!(a0.path_cost(), Some(expected_cost));
    verify_path_continuity(&graph, a0.path_nodes(), a0.path_edges(), expected_cost);

    // A* (Euclidean)
    let mut ae = AStar::new(graph.clone(), source, target, HeuristicType::Euclidean);
    assert_eq!(ae.run_to_completion(100), SearchStatus::Found);
    assert_eq!(ae.path_cost(), Some(expected_cost));
    verify_path_continuity(&graph, ae.path_nodes(), ae.path_edges(), expected_cost);

    // Bidirectional Dijkstra
    let mut bd = BidirectionalDijkstra::new(graph.clone(), source, target);
    assert_eq!(bd.run_to_completion(100), SearchStatus::Found);
    assert_eq!(bd.path_cost(), Some(expected_cost));
    verify_path_continuity(&graph, bd.path_nodes(), bd.path_edges(), expected_cost);

    // Bidirectional A* (Euclidean)
    let mut ba = BidirectionalAStar::new(graph.clone(), source, target, HeuristicType::Euclidean);
    assert_eq!(ba.run_to_completion(100), SearchStatus::Found);
    assert_eq!(ba.path_cost(), Some(expected_cost));
    verify_path_continuity(&graph, ba.path_nodes(), ba.path_edges(), expected_cost);
}

#[test]
fn test_haversine_geographic_search() {
    // 4 European cities:
    // 0: London [51.5074, -0.1278]
    // 1: Paris [48.8566, 2.3522]
    // 2: Brussels [50.8503, 4.3517]
    // 3: Amsterdam [52.3676, 4.9041]
    let london = [51.5074, -0.1278];
    let paris = [48.8566, 2.3522];
    let brussels = [50.8503, 4.3517];
    let amsterdam = [52.3676, 4.9041];

    let nodes = vec![london, paris, brussels, amsterdam];

    // Compute realistic road-like distances using haversine * 1.1 factor
    let d_lon_par = haversine_distance(london, paris) * 1.1;
    let d_lon_bru = haversine_distance(london, brussels) * 1.1;
    let d_par_bru = haversine_distance(paris, brussels) * 1.1;
    let d_bru_ams = haversine_distance(brussels, amsterdam) * 1.1;
    let d_par_ams = haversine_distance(paris, amsterdam) * 1.1;

    let edges = vec![
        (0, 1, d_lon_par),
        (1, 0, d_lon_par),
        (0, 2, d_lon_bru),
        (2, 0, d_lon_bru),
        (1, 2, d_par_bru),
        (2, 1, d_par_bru),
        (2, 3, d_bru_ams),
        (3, 2, d_bru_ams),
        (1, 3, d_par_ams),
        (3, 1, d_par_ams),
    ];

    let graph = Arc::new(Graph::from_edges(nodes, &edges));

    // London (0) to Amsterdam (3)
    let mut dijkstra = Dijkstra::new(graph.clone(), 0, 3);
    assert_eq!(dijkstra.run_to_completion(100), SearchStatus::Found);
    let opt_cost = dijkstra.path_cost().unwrap();

    let mut astar = AStar::new(graph.clone(), 0, 3, HeuristicType::Haversine);
    assert_eq!(astar.run_to_completion(100), SearchStatus::Found);
    assert!((astar.path_cost().unwrap() - opt_cost).abs() < 1e-2);

    let mut bi_dijkstra = BidirectionalDijkstra::new(graph.clone(), 0, 3);
    assert_eq!(bi_dijkstra.run_to_completion(100), SearchStatus::Found);
    assert!((bi_dijkstra.path_cost().unwrap() - opt_cost).abs() < 1e-2);

    let mut bi_astar = BidirectionalAStar::new(graph.clone(), 0, 3, HeuristicType::Haversine);
    assert_eq!(bi_astar.run_to_completion(100), SearchStatus::Found);
    assert!((bi_astar.path_cost().unwrap() - opt_cost).abs() < 1e-2);
}

#[test]
fn test_edge_cases_source_equals_target() {
    let graph = create_grid_graph(3, 3);

    // Dijkstra
    let d = Dijkstra::new(graph.clone(), 4, 4);
    assert_eq!(d.status(), SearchStatus::Found);
    assert_eq!(d.path_cost(), Some(0.0));
    assert_eq!(d.path_nodes(), &[4]);
    assert!(d.path_edges().is_empty());

    // A*
    let a = AStar::new(graph.clone(), 4, 4, HeuristicType::Euclidean);
    assert_eq!(a.status(), SearchStatus::Found);
    assert_eq!(a.path_cost(), Some(0.0));
    assert_eq!(a.path_nodes(), &[4]);

    // Bidirectional Dijkstra
    let bd = BidirectionalDijkstra::new(graph.clone(), 4, 4);
    assert_eq!(bd.status(), SearchStatus::Found);
    assert_eq!(bd.path_cost(), Some(0.0));
    assert_eq!(bd.path_nodes(), &[4]);

    // Bidirectional A*
    let ba = BidirectionalAStar::new(graph.clone(), 4, 4, HeuristicType::Euclidean);
    assert_eq!(ba.status(), SearchStatus::Found);
    assert_eq!(ba.path_cost(), Some(0.0));
    assert_eq!(ba.path_nodes(), &[4]);
}

#[test]
fn test_unreachable_target_disconnected_graph() {
    // Two disconnected nodes
    let nodes = vec![[0.0, 0.0], [10.0, 10.0]];
    let offsets = vec![0, 0, 0];
    let targets = vec![];
    let weights = vec![];
    let graph = Arc::new(Graph::new(nodes, offsets, targets, weights).unwrap());

    let mut d = Dijkstra::new(graph.clone(), 0, 1);
    assert_eq!(d.run_to_completion(10), SearchStatus::NotFound);
    assert_eq!(d.path_cost(), None);

    let mut a = AStar::new(graph.clone(), 0, 1, HeuristicType::Euclidean);
    assert_eq!(a.run_to_completion(10), SearchStatus::NotFound);

    let mut bd = BidirectionalDijkstra::new(graph.clone(), 0, 1);
    assert_eq!(bd.run_to_completion(10), SearchStatus::NotFound);

    let mut ba = BidirectionalAStar::new(graph.clone(), 0, 1, HeuristicType::Euclidean);
    assert_eq!(ba.run_to_completion(10), SearchStatus::NotFound);
}

#[test]
fn test_reset_functionality() {
    let graph = create_grid_graph(4, 4);
    let mut d = Dijkstra::new(graph.clone(), 0, 15);
    assert_eq!(d.run_to_completion(100), SearchStatus::Found);
    assert_eq!(d.path_cost(), Some(6.0));

    // Reset to search between (1, 2) which is cost 1.0
    d.reset(1, 2);
    assert_eq!(d.status(), SearchStatus::InProgress);
    assert_eq!(d.run_to_completion(100), SearchStatus::Found);
    assert_eq!(d.path_cost(), Some(1.0));
    assert_eq!(d.path_nodes(), &[1, 2]);
}

#[test]
fn test_engine_wasm_facade_and_memory_buffers() {
    let mut engine = PathfinderEngine::new();

    // 3 nodes line: 0 --(1.5)--> 1 --(2.5)--> 2
    let flat_coords = vec![0.0, 0.0, 1.0, 1.0, 2.0, 2.0];
    let offsets = vec![0, 1, 2, 2];
    let targets = vec![1, 2];
    let weights = vec![1.5, 2.5];

    assert!(engine
        .load_graph(&flat_coords, &offsets, &targets, &weights)
        .is_ok());

    assert_eq!(engine.get_node_count(), 3);
    assert_eq!(engine.get_edge_count(), 2);
    assert_eq!(engine.get_nodes_len(), 6);
    assert!(!engine.get_nodes_ptr().is_null());
    assert!(!engine.get_offsets_ptr().is_null());
    assert!(!engine.get_targets_ptr().is_null());
    assert!(!engine.get_weights_ptr().is_null());

    // Search 0 -> 2 via Dijkstra
    assert!(engine
        .init_search(AlgorithmType::Dijkstra as u8, 0, 2, 0)
        .is_ok());
    assert_eq!(engine.get_status(), SearchStatus::InProgress as u8);

    let final_status = engine.run_to_completion(100);
    assert_eq!(final_status, SearchStatus::Found as u8);
    assert!((engine.get_path_cost() - 4.0).abs() < 1e-5);

    assert_eq!(engine.get_path_nodes_len(), 3);
    assert_eq!(engine.get_path_edges_len(), 2);
    assert_eq!(engine.get_path_nodes_vec(), vec![0, 1, 2]);
    assert_eq!(engine.get_path_edges_vec(), vec![0, 1]);
    assert!(!engine.get_explored_edges_ptr().is_null());
    assert_eq!(engine.get_explored_edges_len(), 2);
}
