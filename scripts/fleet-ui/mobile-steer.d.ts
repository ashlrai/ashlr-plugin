export function mountMobileSteer(doc: Document, options?: {
  fetcher?: (path: string, options?: RequestInit) => Promise<Response>;
  confirm?: (message: string) => boolean | Promise<boolean>;
}): { ready: Promise<void>; refresh(): Promise<void> };
