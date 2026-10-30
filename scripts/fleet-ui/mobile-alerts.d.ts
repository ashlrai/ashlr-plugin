export function mountMobileAlerts(doc: Document, open: (node: any) => unknown, now?: () => number): {
  update(snapshot: { nodes: any[]; leader_event?: any; errors?: Record<string, unknown>; stale?: boolean } | null): void;
  clear(): void;
};
