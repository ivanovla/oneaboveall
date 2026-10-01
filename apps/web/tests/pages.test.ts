// @vitest-environment node
//
// Server-renders the static .astro pieces through Astro's container API
// (enabled by getViteConfig in vitest.config.ts) and checks the HTML that
// crawlers and visitors actually receive.
import { describe, it, expect, beforeAll } from "vitest";
import { experimental_AstroContainer as AstroContainer } from "astro/container";
import SiteFooter from "../src/components/SiteFooter.astro";
import BaseLayout from "../src/layouts/BaseLayout.astro";
import TermsPage from "../src/pages/terms.astro";
import PrivacyPage from "../src/pages/privacy.astro";

let container: AstroContainer;
beforeAll(async () => {
  container = await AstroContainer.create();
});

function meta(html: string, attr: "name" | "property", key: string): string | undefined {
  const re = new RegExp(`<meta ${attr}="${key.replace(/[.:]/g, "\\$&")}" content="([^"]*)"`);
  return html.match(re)?.[1];
}

describe("SiteFooter", () => {
  it("links to Terms, Privacy and a mailto contact", async () => {
    const html = await container.renderToString(SiteFooter);
    expect(html).toContain('href="/terms"');
    expect(html).toContain('href="/privacy"');
    expect(html).toContain('href="mailto:oneabovealldotorg@gmail.com"');
  });
});

describe("BaseLayout link previews", () => {
  it("emits description, canonical, Open Graph, Twitter, theme-color and favicon with defaults", async () => {
    const html = await container.renderToString(BaseLayout, {
      props: { title: "oneaboveall — One above all" },
      request: new Request("http://127.0.0.1:4321/"),
    });
    const desc =
      "One page. One crowd. One above all. Outbid the person in the center and take their seat — you pay only if you win.";
    expect(meta(html, "name", "description")).toBe(desc);
    expect(html).toContain('<link rel="canonical" href="https://oneaboveall.org/">');
    expect(meta(html, "property", "og:type")).toBe("website");
    expect(meta(html, "property", "og:site_name")).toBe("oneaboveall");
    expect(meta(html, "property", "og:title")).toBe("oneaboveall — One above all");
    expect(meta(html, "property", "og:description")).toBe(desc);
    expect(meta(html, "property", "og:url")).toBe("https://oneaboveall.org/");
    expect(meta(html, "property", "og:image")).toBe("https://oneaboveall.org/og.jpg");
    expect(meta(html, "property", "og:image:width")).toBe("1200");
    expect(meta(html, "property", "og:image:height")).toBe("630");
    expect(meta(html, "name", "twitter:card")).toBe("summary_large_image");
    expect(meta(html, "name", "twitter:title")).toBe("oneaboveall — One above all");
    expect(meta(html, "name", "twitter:description")).toBe(desc);
    expect(meta(html, "name", "twitter:image")).toBe("https://oneaboveall.org/og.jpg");
    expect(meta(html, "name", "theme-color")).toBe("#070603");
    expect(html).toContain('href="/favicon.svg"');
  });

  it("uses the public origin for canonical/og:url and honours description/image props", async () => {
    const html = await container.renderToString(BaseLayout, {
      props: { title: "X", description: "Custom", image: "/other.jpg" },
      request: new Request("http://127.0.0.1:4321/terms"),
    });
    expect(html).toContain('<link rel="canonical" href="https://oneaboveall.org/terms">');
    expect(meta(html, "property", "og:url")).toBe("https://oneaboveall.org/terms");
    expect(meta(html, "name", "description")).toBe("Custom");
    expect(meta(html, "property", "og:image")).toBe("https://oneaboveall.org/other.jpg");
  });
});

describe("legal pages", () => {
  it("/terms has its title, the pay-only-if-you-win section and a back link", async () => {
    const html = await container.renderToString(TermsPage, {
      request: new Request("http://127.0.0.1:4321/terms"),
    });
    expect(html).toContain("<title>Terms — oneaboveall</title>");
    expect(html).toContain("Last updated: October 2, 2026");
    expect(html).toMatch(/Payments — you pay only if you win/);
    expect(html).toMatch(/right of withdrawal/);
    expect(html).toMatch(/laws of Spain/);
    expect(html).toContain('href="/"');
    expect(html).not.toMatch(/draft/i);
  });

  it("/privacy has its title, controller, processors and the AEPD", async () => {
    const html = await container.renderToString(PrivacyPage, {
      request: new Request("http://127.0.0.1:4321/privacy"),
    });
    expect(html).toContain("<title>Privacy — oneaboveall</title>");
    expect(html).toContain("Last updated: October 2, 2026");
    expect(html).toContain("Devvally");
    for (const p of ["Stripe", "Resend", "Hetzner", "AEPD"]) expect(html).toContain(p);
    expect(html).toContain('href="/"');
    expect(html).not.toMatch(/draft/i);
  });
});
