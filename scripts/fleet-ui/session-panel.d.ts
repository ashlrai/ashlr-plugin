interface SessionNode { id: string; kind: string; details: Record<string, unknown> }
interface SessionLink { name: string; href: string }
interface SessionView { node: SessionNode; lines: string[]; links: SessionLink[]; state: string }
interface SessionPage {
  offset: number; reset?: boolean; logs: string[] | null;
  job: Record<string, unknown> | null; errors: Record<string, string>;
}
export function createSessionPanel(load: (path: string) => Promise<SessionPage>, render: (view: SessionView) => void): {
  open(node: SessionNode): Promise<void>; close(): void;
};
export function sessionLinks(job: Record<string, unknown> | null): SessionLink[];
export function mountSessionPanel(doc: Document): ReturnType<typeof createSessionPanel>;
