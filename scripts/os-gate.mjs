/** Per-OS gate: every needed job must be success or skipped. */
const needs = JSON.parse(process.env.NEEDS ?? "{}");
const bad = [];
for (const [job, info] of Object.entries(needs)) {
  const result = info && typeof info === "object" ? info.result : undefined;
  if (result !== "success" && result !== "skipped") bad.push(`${job}=${result}`);
}
if (bad.length) {
  console.error(bad.join(", "));
  process.exit(1);
}
console.log(`OS gate passed ${Object.entries(needs).map(([job, info]) => `${job}=${info.result}`).join(" ")}`);
