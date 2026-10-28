/** Narrow host surface, checked against locally generated Claude plugin types.
 * Function hooks run without Node; all effects must go through the host.
 * The person decider requires Claude Code >= 2.1.309.
 */
export interface ProcessHost {
  process: {
    run(argv: readonly string[], init?: { stdin?: string; timeoutMs?: number }):
      Promise<{ exitCode: number; stdout: string; stderr: string }>;
  };
}

export interface Host extends ProcessHost {
  command: { register(spec: { name: string; description: string; argumentHint?: string; immediate?: boolean }): Promise<unknown> };
  clock: { every(ms: number, fn: () => Promise<void>): { cancel(): void } };
  ui: {
    open(spec: { id: string; title: string; columns: number; rows: number }): Promise<{ isPlaced: boolean }>;
    invalidate(component: "ui.render"): void;
    log(text: string): void;
    resolve(event: RenderEvent): { Box: unknown; Text: unknown };
  };
}

export interface Step {
  turnId: string; index: number; model: string; messageCount: number; agentId?: string;
}
export interface StepResult {
  turnId: string; index: number; answer: string; toolUses: readonly unknown[];
  stopReason: null; usage: null;
}
export interface Spawn {
  prompt: string; description: string; subagentType: string; parentModel: string;
  model?: string; fork: boolean;
}
export interface RenderEvent {
  component: string; requestId?: string;
  viewport?: { isFullscreen?: boolean };
  props: { bodyColumns?: number; scroll?: { bodyRows?: number } };
}
export interface CommandEvent { command: string; args: string; origin: { kind: string } }
export type Decision = { decision: "deny" | "ask"; decider: "person"; reason: string };
type Next<E, R> = (event: E) => R;
type Handler<E, R> = ($: Host, e: E, next: Next<E, R>) => R;
type Registration<E, R> = { catch(handler: Handler<E, R>): void };
export interface On {
  (event: "session.start", fn: ($: Host, e: { cwd: string }, next: Next<{ cwd: string }, Promise<unknown>>) => Promise<unknown>): unknown;
  (event: "session.end", fn: ($: Host, e: unknown, next: Next<unknown, Promise<unknown>>) => Promise<unknown>): unknown;
  (event: "turn.step", fn: Handler<Step, AsyncGenerator<unknown, unknown>>): Registration<Step, AsyncGenerator<unknown, unknown>>;
  (event: "agent.spawn", fn: Handler<Spawn, Promise<unknown>>): Registration<Spawn, Promise<unknown>>;
  (event: "tool.check", fn: Handler<{ tool: string; input: unknown }, Promise<unknown>>): Registration<{ tool: string; input: unknown }, Promise<unknown>>;
  (event: "command.run", matcher: { command: string }, fn: ($: Host, e: CommandEvent, next: Next<CommandEvent, Promise<unknown>>) => Promise<unknown>): unknown;
  (event: "ui.render", matcher: { component: string }, fn: ($: Host, e: RenderEvent, next: Next<RenderEvent, Promise<unknown>>) => Promise<unknown>): unknown;
  (event: "ui.close", matcher: { id: string }, fn: ($: Host, e: unknown, next: Next<unknown, Promise<unknown>>) => Promise<unknown>): unknown;
}
