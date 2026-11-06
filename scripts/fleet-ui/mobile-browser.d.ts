export function mountMobileBrowser(doc: Document, options?: {
  fetcher?: (path: string, init?: RequestInit) => Promise<Response>;
}): { open(job: string): void; poll(): Promise<void>; pause(): void; close(): void };
