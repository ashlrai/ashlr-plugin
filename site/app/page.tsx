import Nav from "@/components/nav";
import Hero from "@/components/hero";
import CodexNative from "@/components/codex-native";
import BeforeAfter from "@/components/before-after";
import HowItWorks from "@/components/how-it-works";
import ToolsGrid from "@/components/tools-grid";
import PricingPreview from "@/components/pricing-preview";
import SocialProof from "@/components/social-proof";
import FaqTeaser from "@/components/faq-teaser";
import Footer from "@/components/footer";

export default function Home() {
  return (
    <>
      <Nav />
      <main>
        <Hero />
        <CodexNative />
        <BeforeAfter />
        <HowItWorks />
        <ToolsGrid />
        <PricingPreview />
        <SocialProof />
        <FaqTeaser />
      </main>
      <Footer />
    </>
  );
}
