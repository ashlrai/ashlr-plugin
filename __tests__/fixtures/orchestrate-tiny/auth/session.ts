import { login } from "./index";

export function startSession(user: string): string {
  return `session:${login(user)}`;
}
