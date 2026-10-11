//! Geographic and coordinate distance metrics for pathfinding heuristics.

use serde::{Deserialize, Serialize};

/// Earth's mean radius in meters according to WGS84 / IUGG.
pub const EARTH_RADIUS_METERS: f32 = 6_371_000.0;

/// Supported heuristic distance calculation methods.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[repr(u8)]
pub enum HeuristicType {
    /// Zero heuristic, turning A* into standard Dijkstra.
    #[default]
    Zero = 0,
    /// Standard planar Euclidean distance.
    Euclidean = 1,
    /// Spherical great-circle distance using Haversine formula (meters).
    Haversine = 2,
    /// Fast equirectangular flat approximation (meters).
    Equirectangular = 3,
}

impl HeuristicType {
    pub fn from_u8(val: u8) -> Self {
        match val {
            1 => HeuristicType::Euclidean,
            2 => HeuristicType::Haversine,
            3 => HeuristicType::Equirectangular,
            _ => HeuristicType::Zero,
        }
    }
}

/// Computes the Euclidean distance between two 2D points [lat1, lon1] and [lat2, lon2].
#[inline]
pub fn euclidean_distance(a: [f32; 2], b: [f32; 2]) -> f32 {
    let d_lat = b[0] - a[0];
    let d_lon = b[1] - a[1];
    (d_lat * d_lat + d_lon * d_lon).sqrt()
}

/// Computes the spherical great-circle distance in meters between two [lat, lon] coordinates in degrees.
#[inline]
pub fn haversine_distance(a: [f32; 2], b: [f32; 2]) -> f32 {
    let lat1 = a[0].to_radians();
    let lon1 = a[1].to_radians();
    let lat2 = b[0].to_radians();
    let lon2 = b[1].to_radians();

    let d_lat = lat2 - lat1;
    let d_lon = lon2 - lon1;

    let sin_half_dlat = (d_lat * 0.5).sin();
    let sin_half_dlon = (d_lon * 0.5).sin();

    let h = sin_half_dlat * sin_half_dlat + lat1.cos() * lat2.cos() * sin_half_dlon * sin_half_dlon;
    // Guard against floating point rounding errors slightly exceeding 1.0
    let h_clamped = h.min(1.0).max(0.0);
    2.0 * EARTH_RADIUS_METERS * h_clamped.sqrt().asin()
}

/// Fast equirectangular approximation of distance in meters for geographic coordinates.
#[inline]
pub fn equirectangular_distance(a: [f32; 2], b: [f32; 2]) -> f32 {
    let lat1 = a[0].to_radians();
    let lon1 = a[1].to_radians();
    let lat2 = b[0].to_radians();
    let lon2 = b[1].to_radians();

    let x = (lon2 - lon1) * ((lat1 + lat2) * 0.5).cos();
    let y = lat2 - lat1;

    EARTH_RADIUS_METERS * (x * x + y * y).sqrt()
}

/// Computes the heuristic distance between two points according to the given heuristic type.
#[inline]
pub fn compute_heuristic(a: [f32; 2], b: [f32; 2], heuristic: HeuristicType) -> f32 {
    match heuristic {
        HeuristicType::Zero => 0.0,
        HeuristicType::Euclidean => euclidean_distance(a, b),
        HeuristicType::Haversine => haversine_distance(a, b),
        HeuristicType::Equirectangular => equirectangular_distance(a, b),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_euclidean_distance() {
        let p1 = [0.0, 0.0];
        let p2 = [3.0, 4.0];
        let d = euclidean_distance(p1, p2);
        assert!((d - 5.0).abs() < 1e-5);
    }

    #[test]
    fn test_haversine_distance() {
        // Paris [48.8566, 2.3522] to London [51.5074, -0.1278] ~ 343 km
        let paris = [48.8566, 2.3522];
        let london = [51.5074, -0.1278];
        let d = haversine_distance(paris, london);
        assert!((d - 343_500.0).abs() < 5_000.0);

        // Same point distance must be 0
        assert_eq!(haversine_distance(paris, paris), 0.0);
    }
}
