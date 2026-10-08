import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

// The product info we fetch from Shopify for each registry item
type VariantDetails = {
  productTitle: string;
  variantTitle: string;
  price: string;
  imageUrl: string | null;
};

type VariantNode = {
  id: string;
  title: string;
  price: string;
  image: { url: string } | null;
  product: { title: string; featuredImage: { url: string } | null };
};

// Runs when the page loads: get the registry from our database,
// then ask Shopify's GraphQL API for each product's name, price and image
export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  if (!params.id) throw new Response("Registry not found", { status: 404 });

  // Checking `shop` too means one store can never open another store's registry
  const registry = await prisma.registry.findFirst({
    where: { id: params.id, shop: session.shop },
    include: { items: { orderBy: { createdAt: "asc" } } },
  });
  if (!registry) throw new Response("Registry not found", { status: 404 });

  const details: Record<string, VariantDetails> = {};

  if (registry.items.length > 0) {
    // One request for all items, instead of one request per item
    const response = await admin.graphql(
      `#graphql
      query RegistryVariants($ids: [ID!]!) {
        nodes(ids: $ids) {
          ... on ProductVariant {
            id
            title
            price
            image { url }
            product { title featuredImage { url } }
          }
        }
      }`,
      { variables: { ids: registry.items.map((item) => item.variantId) } },
    );
    const json = (await response.json()) as {
      data?: { nodes: Array<VariantNode | null> };
    };

    for (const node of json.data?.nodes ?? []) {
      if (!node) continue; // product was deleted from the store
      details[node.id] = {
        productTitle: node.product.title,
        variantTitle: node.title,
        price: node.price,
        imageUrl: node.image?.url ?? node.product.featuredImage?.url ?? null,
      };
    }
  }

  const items = registry.items.map((item) => ({
    ...item,
    details: details[item.variantId] ?? null,
  }));

  return { registry, items };
};

// Runs when something on the page is submitted: add, update or remove items
export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  if (!params.id) throw new Response("Registry not found", { status: 404 });

  const registry = await prisma.registry.findFirst({
    where: { id: params.id, shop: session.shop },
  });
  if (!registry) throw new Response("Registry not found", { status: 404 });

  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");

  if (intent === "add") {
    const picked = JSON.parse(String(form.get("items") ?? "[]")) as Array<{
      productId: string;
      variantId: string;
    }>;

    // upsert = add it if new, leave it alone if it's already on the registry
    for (const p of picked) {
      await prisma.registryItem.upsert({
        where: {
          registryId_variantId: { registryId: registry.id, variantId: p.variantId },
        },
        update: {},
        create: {
          registryId: registry.id,
          productId: p.productId,
          variantId: p.variantId,
        },
      });
    }
  }

  if (intent === "quantity") {
    const itemId = String(form.get("itemId") ?? "");
    const quantity = Math.min(99, Math.max(1, Number(form.get("quantity")) || 1));
    await prisma.registryItem.updateMany({
      where: { id: itemId, registryId: registry.id },
      data: { quantityWanted: quantity },
    });
  }

  if (intent === "remove") {
    const itemId = String(form.get("itemId") ?? "");
    await prisma.registryItem.deleteMany({
      where: { id: itemId, registryId: registry.id },
    });
  }

  return { ok: true };
};

export default function RegistryDetail() {
  const { registry, items } = useLoaderData<typeof loader>();
  const shopify = useAppBridge();
  const fetcher = useFetcher();
  const isBusy = fetcher.state !== "idle";

  // Opens Shopify's built-in product picker, then saves what was chosen
  async function pickProducts() {
    const selected = await shopify.resourcePicker({ type: "product", multiple: true });
    if (!selected || selected.length === 0) return; // picker was cancelled

    const picked = selected.flatMap((product) =>
      (product.variants ?? [])
        .filter((variant) => variant.id)
        .map((variant) => ({ productId: product.id, variantId: variant.id as string })),
    );

    fetcher.submit({ intent: "add", items: JSON.stringify(picked) }, { method: "post" });
  }

  return (
    <s-page heading={registry.title}>
      <s-section>
        <s-stack gap="base">
          <s-link href="/app/registries">← All registries</s-link>
          <s-paragraph>
            {registry.registrantName} · {registry.registrantEmail} · {registry.eventType}
            {registry.eventDate
              ? ` · ${new Date(registry.eventDate).toLocaleDateString()}`
              : ""}
          </s-paragraph>
          <s-paragraph>Share link: /registry/{registry.slug}</s-paragraph>
        </s-stack>
      </s-section>

      <s-section heading={`Items (${items.length})`}>
        <s-stack gap="base">
          <s-button variant="primary" onClick={pickProducts}>
            {isBusy ? "Saving…" : "Add products"}
          </s-button>

          {items.length === 0 ? (
            <s-paragraph>
              No items yet. Click "Add products" to choose from your store.
            </s-paragraph>
          ) : (
            <s-table>
              <s-table-header-row>
                <s-table-header>Product</s-table-header>
                <s-table-header>Price</s-table-header>
                <s-table-header>Wanted</s-table-header>
                <s-table-header>Purchased</s-table-header>
                <s-table-header>Remove</s-table-header>
              </s-table-header-row>
              <s-table-body>
                {items.map((item) => (
                  <s-table-row key={item.id}>
                    <s-table-cell>
                      <s-stack direction="inline" gap="small" alignItems="center">
                        {item.details?.imageUrl ? (
                          <s-thumbnail
                            src={item.details.imageUrl}
                            alt={item.details.productTitle}
                            size="small"
                          />
                        ) : null}
                        <s-text>
                          {item.details
                            ? item.details.variantTitle === "Default Title"
                              ? item.details.productTitle
                              : `${item.details.productTitle} – ${item.details.variantTitle}`
                            : "Product no longer available"}
                        </s-text>
                      </s-stack>
                    </s-table-cell>
                    <s-table-cell>
                      {item.details ? `$${item.details.price}` : "—"}
                    </s-table-cell>
                    <s-table-cell>
                      <fetcher.Form method="post" key={item.quantityWanted}>
                        <input type="hidden" name="intent" value="quantity" />
                        <input type="hidden" name="itemId" value={item.id} />
                        <s-stack direction="inline" gap="small">
                          <s-number-field
                            label="Quantity wanted"
                            labelAccessibilityVisibility="exclusive"
                            name="quantity"
                            value={String(item.quantityWanted)}
                            min={1}
                            max={99}
                          />
                          <s-button type="submit">Save</s-button>
                        </s-stack>
                      </fetcher.Form>
                    </s-table-cell>
                    <s-table-cell>
                      {item.quantityPurchased} / {item.quantityWanted}
                    </s-table-cell>
                    <s-table-cell>
                      <fetcher.Form method="post">
                        <input type="hidden" name="intent" value="remove" />
                        <input type="hidden" name="itemId" value={item.id} />
                        <s-button type="submit" tone="critical" variant="tertiary">
                          Remove
                        </s-button>
                      </fetcher.Form>
                    </s-table-cell>
                  </s-table-row>
                ))}
              </s-table-body>
            </s-table>
          )}
        </s-stack>
      </s-section>
    </s-page>
  );
}