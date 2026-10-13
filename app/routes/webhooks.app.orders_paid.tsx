import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

// The parts of Shopify's order data we use
type OrderPayload = {
  admin_graphql_api_id: string;
  line_items: Array<{
    variant_id: number | null;
    quantity: number;
    properties: Array<{ name: string; value: string }> | null;
  }>;
};

// Shopify calls this URL every time an order is paid
export const action = async ({ request }: ActionFunctionArgs) => {
  // Verifies Shopify's signature (HMAC) so nobody can fake an order
  const { shop, topic, payload } = await authenticate.webhook(request);
  console.log(`🎁 Received ${topic} webhook for ${shop}`);

  const order = payload as OrderPayload;
  const orderId = order.admin_graphql_api_id;

  // 1. Find the registry items in this order, adding up quantities
  //    in case the same gift appears on more than one line
  const gifts = new Map<string, { registryId: string; variantId: string; quantity: number }>();

  for (const line of order.line_items) {
    const registryId = line.properties?.find((p) => p.name === "_registry_id")?.value;
    if (!registryId || !line.variant_id) continue; // a normal purchase, not a gift

    const variantId = `gid://shopify/ProductVariant/${line.variant_id}`;
    const key = `${registryId}|${variantId}`;
    const existing = gifts.get(key);

    gifts.set(key, {
      registryId,
      variantId,
      quantity: (existing?.quantity ?? 0) + line.quantity,
    });
  }

  // 2. Record each gift as purchased
  for (const gift of gifts.values()) {
    const item = await prisma.registryItem.findFirst({
      where: {
        registryId: gift.registryId,
        variantId: gift.variantId,
        registry: { shop }, // only this store's registries
      },
    });
    if (!item) continue; // item was removed from the registry

    try {
      // Both writes succeed together, or neither does
      await prisma.$transaction([
        prisma.purchase.create({
          data: { itemId: item.id, orderId, quantity: gift.quantity },
        }),
        prisma.registryItem.update({
          where: { id: item.id },
          data: { quantityPurchased: { increment: gift.quantity } },
        }),
      ]);
      console.log(`   ✓ Marked ${gift.quantity} purchased on registry item ${item.id}`);
    } catch (error) {
      // P2002 = this order + item was already recorded.
      // Shopify can send the same webhook twice, so we skip duplicates.
      if ((error as { code?: string }).code === "P2002") {
        console.log(`   ↺ Duplicate webhook for order ${orderId}, skipped`);
        continue;
      }
      throw error;
    }
  }

  // Tell Shopify "got it" so it doesn't retry
  return new Response();
};