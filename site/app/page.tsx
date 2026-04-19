import { readFileSync, existsSync } from "fs";
import { resolve } from "path";
import Nav from "@/components/nav";
import Hero from "@/components/hero";
import BeforeAfter from "@/components/before-after";
import HowItWorks from "@/components/how-it-works";
import ToolsGrid from "@/components/tools-grid";
import SkillsGrid from "@/components/skills-grid";
import DemoChart from "@/components/demo-chart";
import PricingPreview from "@/components/pricing-preview";
import SocialProof from "@/components/social-proof";
import Footer from "@/components/footer";

function readSavingsPct(): string {
  const candidates = [
    resolve(process.cwd(), "docs/benchmarks-v2.json"),
    resolve(process.cwd(), "../docs/benchmarks-v2.json"),
  ];
  for (const p of candidates) {
    if (existsSync(p)) {
      try {
        const data = JSON.parse(readFileSync(p, "utf-8"));
        const overall: number = data?.aggregate?.overall?.mean;
        if (typeof overall === "number" && Number.isFinite(overall)) {
          return ((1 - overall) * 100).toFixed(1);
        }
      } catch {
        // fall through to default
      }
    }
  }
  return "79.5";
}

export default function Home() {
  const savingsPct = readSavingsPct();
  return (
    <>
      <Nav />
      <main>
        <Hero savingsPct={savingsPct} />
        <BeforeAfter />
        <HowItWorks />
        <ToolsGrid />
        <SkillsGrid />
        <DemoChart />
        <PricingPreview />
        <SocialProof />
      </main>
      <Footer />
    </>
  );
}
