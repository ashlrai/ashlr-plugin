interface FilterNode { id: string; kind: string; lane?: string; details: Record<string, unknown> }
export function createMapFilter(): {
  apply(nodes: FilterNode[], now: number): void;
  alpha(node: FilterNode, query: string): number;
  details(node: FilterNode): Record<string, unknown>;
  pulse(id: string, now: number): number;
};
