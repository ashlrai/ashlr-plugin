interface MapNode { id: string; kind: string; lane: string; details: Record<string, unknown> }
interface MapLink { source: string; target: string }
interface MapGraph { nodes: MapNode[]; links: MapLink[]; leader: unknown; errors: Record<string, string> }
interface SnapshotPage {
  schema_version: number; cursor: string;
  lanes?: Record<string, unknown> | null; jobs?: Record<string, unknown> | null; prs?: Record<string, unknown> | null;
  leader?: unknown; errors?: Record<string, string>; removed?: Record<string, string[]>;
}
interface Positioned { node: MapNode; x: number; y: number; z: number }
interface MapPoint { node: MapNode; x: number; y: number; depth: number }
interface MapCamera { angle: number; tilt: number; zoom: number }
export function createNodeMap(): {
  apply(page: SnapshotPage): void; graph(): MapGraph; resetCursor(): void;
  readonly cursor: string | undefined; readonly leader: unknown; readonly errors: Record<string, string>;
};
export function layout(nodes: MapNode[]): Positioned[];
export function project(items: Positioned[], camera: MapCamera, width: number, height: number): MapPoint[];
export function pick(points: MapPoint[], x: number, y: number, radius?: number): MapNode | null;
export function mountNodeMap(doc: Document, options?: {
  open?: (node: MapNode) => void;
  fetcher?: (path: string, init?: RequestInit) => Promise<Response>;
  schedule?: typeof setTimeout; cancel?: typeof clearTimeout;
  interval?: number; frame?: (callback: () => void) => number;
}): {
  ready: Promise<void>; poll(): Promise<void>; draw(): void; select(id: string): void;
  map: ReturnType<typeof createNodeMap>; readonly points: MapPoint[]; readonly selected: string; stop(): void;
};
