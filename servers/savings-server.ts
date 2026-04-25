/**
 * savings-server — ashlr__savings tool implementation.
 *
 * Reads stats + session, builds extra context, and delegates rendering to
 * _savings-render.ts. Self-contained; no shared mutable state.
 */

import { readStats, readCurrentSession } from "./_stats";
import { renderSavings } from "./_savings-render";
import {
  buildTopProjects,
  readCalibrationState,
  type ExtraContext,
} from "../scripts/savings-report-extras";
import { readNudgeSummary } from "./_nudge-events";
import { statSync } from "fs";
import { homedir } from "os";
import { join as joinPath } from "path";

function hasProToken(): boolean {
  try {
    const p = joinPath(process.env.HOME ?? homedir(), ".ashlr", "pro-token");
    const s = statSync(p);
    return s.isFile() && s.size > 0;
  } catch { return false; }
}

export async function ashlrSavings(): Promise<string> {
  const stats = await readStats();
  const session = await readCurrentSession();
  const topProjects = buildTopProjects();
  const { ratio: calibrationRatio, present: calibrationPresent } = readCalibrationState();
  const nudgeSummary = await readNudgeSummary();
  const proUser = hasProToken();
  const extra: ExtraContext = { topProjects, calibrationRatio, calibrationPresent, nudgeSummary, proUser };
  return renderSavings(session, stats.lifetime, extra);
}
