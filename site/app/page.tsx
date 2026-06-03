import Nav from "@/components/nav";
import Hero from "@/components/hero";
import CodexNative from "@/components/codex-native";
import BeforeAfter from "@/components/before-after";
import HowItWorks from "@/components/how-it-works";
import ToolsGrid from "@/components/tools-grid";
import PricingPreview from "@/components/pricing-preview";
import SocialProof from "@/components/social-proof";
import Footer from "@/components/footer";

function readSavingsPct(): string {
  return "57";
}

export default function Home() {
  const savingsPct = readSavingsPct();
  return (
    <>
      <Nav />
      <main>
        <Hero savingsPct={savingsPct} />
        <CodexNative />
        <BeforeAfter />
        <HowItWorks />
        <ToolsGrid />
        <PricingPreview />
        <SocialProof />
      </main>
      <Footer />
    </>
  );
}
