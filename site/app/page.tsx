import Nav from "@/components/nav";
import Hero from "@/components/hero";
import ToolsGrid from "@/components/tools-grid";
import SkillsGrid from "@/components/skills-grid";
import DemoChart from "@/components/demo-chart";
import PricingPreview from "@/components/pricing-preview";
import SocialProof from "@/components/social-proof";
import Footer from "@/components/footer";

export default function Home() {
  return (
    <>
      <Nav />
      <main>
        <Hero />
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
