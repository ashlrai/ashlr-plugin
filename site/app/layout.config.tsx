import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";

export const baseOptions: BaseLayoutProps = {
  nav: {
    title: "ashlr",
    url: "/",
  },
  links: [
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
