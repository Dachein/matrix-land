import { platformBrandFromEnv, type PlatformBrandEnv } from "../src/shared/platformBrand.ts";

/** Render each installation's public brand without domain compatibility redirects. */
export const onRequest: PagesFunction<PlatformBrandEnv> = async (context) => {
  const response = await context.next();
  if (!response.headers.get("content-type")?.includes("text/html") || new URL(context.request.url).pathname.startsWith("/api/")) return response;
  const brand = platformBrandFromEnv(context.env);
  const rewriter = new HTMLRewriter()
    .on("title", { element(element) { element.setInnerContent(brand.name); } })
    .on('meta[property="og:site_name"], meta[property="og:title"], meta[name="twitter:title"]', {
      element(element) { element.setAttribute("content", brand.name); }
    });
  if (brand.logoUrl) rewriter.on('link[rel="icon"]', { element(element) {
    element.setAttribute("href", brand.logoUrl!); element.removeAttribute("type"); element.removeAttribute("sizes");
  } });
  return rewriter.transform(response);
};
