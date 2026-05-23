import { apiPay } from "./index";

export function payRoute(user: string, cents: number): string {
  return apiPay(user, cents);
}
