export function mountSteerPanel(doc: Document, fetcher?: (path: string, options?: RequestInit) => Promise<Response>, confirm?: (message: string) => boolean | Promise<boolean>): {
  open(node: { id: string; kind: string; lane?: string; details: Record<string, unknown> }): Promise<void>;
};
