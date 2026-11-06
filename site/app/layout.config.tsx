import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";

export const baseOptions: BaseLayoutProps = {
  nav: {
    title: "ashlr",
    url: "/",
  },
  links: [
    { text: "Use cases", url: "/use-cases" },
    { text: "Install", url: "/docs/getting-started/install" },
    {
      text: "Docs",
      url: "/docs",
      active: "nested-url",
    },
    {
      text: "Pricing",
      url: "/pricing",
    },
    {
      text: "GitHub",
      url: "https://github.com/ashlrai/ashlr-plugin",
      external: true,
    },
  ],
};
