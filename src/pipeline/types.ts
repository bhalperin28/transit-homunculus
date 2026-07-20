export interface CityArea {
  name: string;
  slug: string;
  lat: number;
  lon: number;
  /** Radius in meters used to bound the analysis area around the center point. */
  radiusMeters: number;
}

export interface LatLon {
  lat: number;
  lon: number;
}

export interface Anchor extends LatLon {
  id: number;
  /** Nearest routable road-graph node id, filled in once the network is loaded. */
  nodeId?: number;
  /** Local planar projection (meters from city center), used for grid math + MDS init. */
  x: number;
  y: number;
}

export type Mode = "freeflow" | "rushhour" | "transit";

export interface GraphNode extends LatLon {
  id: number;
}

export interface GraphEdge {
  from: number;
  to: number;
  /** Meters. */
  length: number;
  /** Free-flow travel time, seconds. */
  freeflowSeconds: number;
  /** Rush-hour travel time, seconds. */
  rushhourSeconds: number;
  highway: string;
  kind: "road" | "transit" | "walk";
}

export interface RoadGraph {
  nodes: Map<number, GraphNode>;
  edges: GraphEdge[];
  /** Adjacency list: nodeId -> edge indices. */
  adjacency: Map<number, number[]>;
}

export interface SampleTrip {
  id: string;
  label: string;
  fromAnchor: number;
  toAnchor: number;
  fastest: LatLon[];
  fastestSeconds: number;
  shortest: LatLon[];
  shortestSeconds: number;
  mode: Mode;
}

export interface ModeResult {
  mode: Mode;
  /** anchors.length x anchors.length seconds matrix, -1 = unreachable. */
  matrix: number[][];
  /** 2D embedded coordinates (meters, same scale as anchor.x/y) per anchor index. */
  embedding: { x: number; y: number }[];
  /** Per-anchor embedding stress (distortion), used for the x-ray view. */
  stress: number[];
  sampleTrips: SampleTrip[];
}

export interface CityDataset {
  city: CityArea;
  generatedAt: string;
  anchors: Anchor[];
  modes: ModeResult[];
  meta: {
    anchorCount: number;
    edgeCount: number;
    transitAvailable: boolean;
  };
}
