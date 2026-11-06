export function mountMobile(doc: Document, options?: {
  fetcher?: (path: string, init?: RequestInit) => Promise<Response>; schedule?: typeof setTimeout; cancel?: typeof clearTimeout; now?: () => Date;
  onSnapshot?: (snapshot: { nodes: unknown[] }) => void;
}): { ready: Promise<void>; poll(): Promise<void>; stop(): void };
