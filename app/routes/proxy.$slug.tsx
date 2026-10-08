import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

type VariantNode = {
  id: string;
  title: string;
  price: string;
  availableForSale: boolean;
  inventoryQuantity: number | null;
  inventoryPolicy: "DENY" | "CONTINUE";
  inventoryItem: { tracked: boolean };
  image: { url: string } | null;
  product: { title: string; onlineStoreUrl: string | null; featuredImage: { url: string } | null };
};

// Makes text safe to put inside HTML, so a product named "<script>"
// can't break the page. Curly braces are escaped too, because Shopify
// renders this page as Liquid and {{ }} has special meaning there.
function esc(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .replace(/{/g, "&#123;")
    .replace(/}/g, "&#125;");
}

// "gid://shopify/ProductVariant/12345" -> "12345" (the cart needs the plain number)
function numericId(gid: string) {
  return gid.split("/").pop() ?? "";
}

const styles = `
<style>
  .gr-wrap { max-width: 1100px; margin: 0 auto; padding: 40px 20px; }
  .gr-header { text-align: center; margin-bottom: 40px; }
  .gr-eyebrow { text-transform: uppercase; letter-spacing: 0.12em; font-size: 13px; opacity: 0.7; }
  .gr-title { margin: 8px 0; }
  .gr-meta { opacity: 0.8; }
  .gr-progress { margin-top: 12px; font-weight: 600; }
  .gr-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap: 24px; }
  .gr-card { border: 1px solid rgba(0,0,0,0.1); border-radius: 12px; overflow: hidden; display: flex; flex-direction: column; }
  .gr-card img { width: 100%; aspect-ratio: 1; object-fit: cover; background: #f4f4f4; }
  .gr-body { padding: 16px; display: flex; flex-direction: column; gap: 8px; flex: 1; }
  .gr-name { font-weight: 600; }
  .gr-needed { font-size: 14px; opacity: 0.8; }
  .gr-body form { margin-top: auto; }
  .gr-body button { width: 100%; }
  .gr-done { margin-top: auto; text-align: center; padding: 10px; border-radius: 8px; background: #eef7ee; color: #1e6b1e; font-weight: 600; }
  .gr-empty { text-align: center; opacity: 0.8; }
</style>`;

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  // Verifies the request really came from Shopify (signed by the app proxy)
  const { session, admin, liquid } = await authenticate.public.appProxy(request);

  const notFound = liquid(
    `${styles}<div class="gr-wrap gr-empty"><h1>Registry not found</h1><p>Check the link and try again.</p></div>`,
  );

  if (!session || !admin || !params.slug) return notFound;

  const registry = await prisma.registry.findFirst({
    where: { shop: session.shop, slug: params.slug, isPublic: true },
    include: { items: { orderBy: { createdAt: "asc" } } },
  });
  if (!registry) return notFound;

  // Fetch live product details and the store's currency in one request
  const response = await admin.graphql(
    `#graphql
    query PublicRegistry($ids: [ID!]!) {
      shop { currencyCode }
      nodes(ids: $ids) {
          ... on ProductVariant {
          id
          title
          price
          availableForSale
          inventoryQuantity
          inventoryPolicy
          inventoryItem { tracked }
          image { url }
          product { title onlineStoreUrl featuredImage { url } }
        }
      }
    }`,
    { variables: { ids: registry.items.map((item) => item.variantId) } },
  );
  const json = (await response.json()) as {
    data?: { shop: { currencyCode: string }; nodes: Array<VariantNode | null> };
  };

  const currency = json.data?.shop.currencyCode ?? "CAD";
  const money = new Intl.NumberFormat("en-CA", { style: "currency", currency });
  const variants = new Map(
    (json.data?.nodes ?? [])
      .filter((node): node is VariantNode => Boolean(node))
      .map((node) => [node.id, node]),
  );

  const totalWanted = registry.items.reduce((sum, i) => sum + i.quantityWanted, 0);
  const totalBought = registry.items.reduce(
    (sum, i) => sum + Math.min(i.quantityPurchased, i.quantityWanted),
    0,
  );

  const cards = registry.items
    .map((item) => {
      const variant = variants.get(item.variantId);
      if (!variant) return ""; // product was deleted from the store

      const name =
        variant.title === "Default Title"
          ? variant.product.title
          : `${variant.product.title} – ${variant.title}`;
      const image = variant.image?.url ?? variant.product.featuredImage?.url;
      const remaining = Math.max(0, item.quantityWanted - item.quantityPurchased);
            // Can a guest actually buy this right now?
      const published = Boolean(variant.product.onlineStoreUrl);
      const inStock =
        variant.availableForSale &&
        (!variant.inventoryItem.tracked ||
          variant.inventoryPolicy === "CONTINUE" ||
          (variant.inventoryQuantity ?? 0) > 0);

      // A standard Shopify cart form. The hidden "_registry_id" property travels
      // with the order, so the webhook (next feature) knows which registry it's for.
      const action =
               remaining === 0
          ? `<div class="gr-done">Fully gifted ✓</div>`
          : !published
            ? `<div class="gr-done">Not available online</div>`
            : !inStock
              ? `<div class="gr-done">Sold out</div>`
            : `<form action="/cart/add" method="post">
                 <input type="hidden" name="id" value="${esc(numericId(variant.id))}">
                 <input type="hidden" name="quantity" value="1">
                 <input type="hidden" name="properties[_registry_id]" value="${esc(registry.id)}">
                 <button type="submit" class="button button--primary">Add to cart</button>
               </form>`;

      return `
        <div class="gr-card">
          ${image ? `<img src="${esc(image)}" alt="${esc(name)}" loading="lazy">` : ""}
          <div class="gr-body">
            <div class="gr-name">${esc(name)}</div>
            <div>${esc(money.format(Number(variant.price)))}</div>
            <div class="gr-needed">${remaining} of ${item.quantityWanted} still needed</div>
            ${action}
          </div>
        </div>`;
    })
    .join("");

  const eventDate = registry.eventDate
    ? new Date(registry.eventDate).toLocaleDateString("en-CA", {
        dateStyle: "long",
        timeZone: "UTC",
      })
    : "";

  return liquid(`
    ${styles}
    <div class="gr-wrap">
      <div class="gr-header">
        <div class="gr-eyebrow">${esc(registry.eventType)} registry</div>
        <h1 class="gr-title">${esc(registry.title)}</h1>
        <div class="gr-meta">${esc(registry.registrantName)}${eventDate ? ` · ${esc(eventDate)}` : ""}</div>
        ${totalWanted > 0 ? `<div class="gr-progress">${totalBought} of ${totalWanted} gifts purchased</div>` : ""}
      </div>
      ${
        cards
          ? `<div class="gr-grid">${cards}</div>`
          : `<p class="gr-empty">No gifts have been added to this registry yet.</p>`
      }
    </div>`);
};