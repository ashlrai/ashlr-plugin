interface MobileSessionNode { id: string; details: Record<string, unknown> }
export function mountMobileSession(doc: Document, options?: {
  fetcher?: (path: string, init?: RequestInit) => Promise<Response>; schedule?: typeof setTimeout; cancel?: typeof clearTimeout;
}): { open(node: MobileSessionNode): Promise<void>; update(nodes: MobileSessionNode[]): void; stop(): void };
