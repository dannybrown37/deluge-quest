import { getCollection } from "astro:content";
import rss from "@astrojs/rss";
import type { APIContext } from "astro";

export async function GET(context: APIContext) {
  const entries = (await getCollection("changelog")).sort(
    (a, b) => b.data.date.getTime() - a.data.date.getTime(),
  );

  return rss({
    title: "deluge.quest changelog",
    description:
      "Notable updates to deluge.quest — bug fixes, new features, and improvements.",
    site: context.site!,
    items: entries.map((entry) => ({
      title: entry.data.title,
      pubDate: entry.data.date,
      link: `/changelog#${entry.id}`,
      categories: [entry.data.tag],
    })),
  });
}
