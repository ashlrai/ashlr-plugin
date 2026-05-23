import { invoice } from "../billing/invoice";
import { startSession } from "../auth/session";

export function apiPay(user: string, cents: number): string {
  startSession(user);
  return invoice(user, cents);
}
