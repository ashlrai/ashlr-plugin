interface ControlNode { id: string; kind: string; lane: string; details: Record<string, unknown> }
export function createControlPanel(send: (body: any) => Promise<any>, confirm: (message: string) => boolean | Promise<boolean>, log: (message: string) => void): (action: string, node: ControlNode, lane: string, slots: string, reason: string) => Promise<void>;
export function mountControlPanel(doc: Document): { open(node: ControlNode): void };
