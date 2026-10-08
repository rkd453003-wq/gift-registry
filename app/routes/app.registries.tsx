import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData, useNavigation } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

const EVENT_TYPES = ["wedding", "baby", "housewarming", "other"] as const;

// Turns "Sam & Alex's Wedding!" into "sam-alex-s-wedding" for the share link
function slugify(text: string) {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50);
}

// Runs on the server when the page loads: fetch this store's registries
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  const registries = await prisma.registry.findMany({
    where: { shop: session.shop },
    orderBy: { createdAt: "desc" },
    include: { _count: { select: { items: true } } },
  });

  return { registries };
};

// Runs on the server when the form is submitted: validate, then create
export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const form = await request.formData();

  const title = String(form.get("title") ?? "").trim();
  const registrantName = String(form.get("registrantName") ?? "").trim();
  const registrantEmail = String(form.get("registrantEmail") ?? "").trim();
  const eventType = String(form.get("eventType") ?? "");
  const eventDate = String(form.get("eventDate") ?? "");

  const errors: Record<string, string> = {};
  if (!title) errors.title = "Title is required";
  if (!registrantName) errors.registrantName = "Name is required";
  if (!/^\S+@\S+\.\S+$/.test(registrantEmail))
    errors.registrantEmail = "Enter a valid email";
  if (!(EVENT_TYPES as readonly string[]).includes(eventType))
    errors.eventType = "Pick an event type";

  if (Object.keys(errors).length > 0) return { errors };

  // Make the share link unique within this store: sam-alex, sam-alex-2, ...
  const base = slugify(title) || "registry";
  let slug = base;
  let n = 2;
  while (
    await prisma.registry.findUnique({
      where: { shop_slug: { shop: session.shop, slug } },
    })
  ) {
    slug = `${base}-${n++}`;
  }

  await prisma.registry.create({
    data: {
      shop: session.shop,
      title,
      registrantName,
      registrantEmail,
      eventType,
      eventDate: eventDate ? new Date(eventDate) : null,
      slug,
    },
  });

  return { success: true };
};

export default function Registries() {
  const { registries } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";
  const errors = (actionData as { errors?: Record<string, string> } | undefined)?.errors ?? {};

  return (
    <s-page heading="Registries">
      <s-section heading="Create a registry">
        {/* key resets the form after each new registry */}
        <Form method="post" key={registries.length}>
          <s-stack gap="base">
            <s-text-field
              label="Registry title"
              name="title"
              placeholder="Sam & Alex's Wedding"
              error={errors.title}
            />
            <s-text-field
              label="Registrant name"
              name="registrantName"
              error={errors.registrantName}
            />
            <s-email-field
              label="Registrant email"
              name="registrantEmail"
              error={errors.registrantEmail}
            />
            <s-select label="Event type" name="eventType" error={errors.eventType}>
              <s-option value="wedding">Wedding</s-option>
              <s-option value="baby">Baby</s-option>
              <s-option value="housewarming">Housewarming</s-option>
              <s-option value="other">Other</s-option>
            </s-select>
            <s-date-field label="Event date (optional)" name="eventDate" />
            <s-button type="submit" variant="primary">
              {isSubmitting ? "Creating…" : "Create registry"}
            </s-button>
          </s-stack>
        </Form>
      </s-section>

      <s-section heading={`All registries (${registries.length})`}>
        {registries.length === 0 ? (
          <s-paragraph>No registries yet. Create your first one above.</s-paragraph>
        ) : (
          <s-table>
            <s-table-header-row>
              <s-table-header>Title</s-table-header>
              <s-table-header>Registrant</s-table-header>
              <s-table-header>Event</s-table-header>
              <s-table-header>Date</s-table-header>
              <s-table-header>Items</s-table-header>
              <s-table-header>Share link</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {registries.map((r) => (
                <s-table-row key={r.id}>
                  <s-table-cell>
                    <s-link href={`/app/registries/${r.id}`}>{r.title}</s-link>
                  </s-table-cell>
                  <s-table-cell>{r.registrantName}</s-table-cell>
                  <s-table-cell>
                    <s-badge>{r.eventType}</s-badge>
                  </s-table-cell>
                  <s-table-cell>
                    {r.eventDate ? new Date(r.eventDate).toLocaleDateString() : "—"}
                  </s-table-cell>
                  <s-table-cell>{r._count.items}</s-table-cell>
                  <s-table-cell>/registry/{r.slug}</s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        )}
      </s-section>
    </s-page>
  );
}