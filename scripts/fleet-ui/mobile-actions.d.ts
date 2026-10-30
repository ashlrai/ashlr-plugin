interface ActionTarget { lane?: string; job_id?: string }
interface ActionNode { id: string; kind: string; lane?: string; details: Record<string, unknown> }
export function createMobileActions(
  send: (body: any) => Promise<any>, confirm: (message: string) => boolean | Promise<boolean>, announce: (message: string) => void,
): (action: string, target: ActionTarget, reason: string) => Promise<void>;
export function mountMobileActions(doc: Document, options?: {
  send?: (body: any) => Promise<any>; confirm?: (message: string) => boolean | Promise<boolean>; announce?: (message: string) => void;
}): { run(action: string, target: ActionTarget, reason: string): Promise<void>; update(snapshot: { nodes?: ActionNode[] } | null | undefined): void };
