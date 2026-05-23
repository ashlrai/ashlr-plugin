import { startSession } from "../auth/session";

export function charge(user: string, cents: number): string {
  return `${startSession(user)}:${cents}`;
}
