interface SessionNode { id: string; kind: string; details: Record<string, unknown> }
interface SessionLink { name: string; href: string }
interface BrowserView { cursor: string; url: string | null; latest: string | null; frames: string[] }
interface SessionView { node: SessionNode; lines: string[]; links: SessionLink[]; state: string; browser: BrowserView | null }
interface SessionPage {
  offset: number; reset?: boolean; logs: string[] | null;
  job: Record<string, unknown> | null; errors: Record<string, string>;
}
interface BrowserPage {
  latest_frame_path: string | null; current_url: string | null;
  frames: { index: number; path: string }[]; cursor: string; has_more: boolean;
}
export function createSessionPanel(load: (path: string) => Promise<SessionPage | BrowserPage>, render: (view: SessionView) => void): {
  open(node: SessionNode): Promise<void>; close(): void;
};
export function sessionLinks(job: Record<string, unknown> | null): SessionLink[];
export function mountSessionPanel(doc: Document): ReturnType<typeof createSessionPanel>;
