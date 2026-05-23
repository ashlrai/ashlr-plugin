import { charge } from "./index";

export function invoice(user: string, cents: number): string {
  return `invoice:${charge(user, cents)}`;
}
