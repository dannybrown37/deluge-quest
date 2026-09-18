import { defineCollection, z } from "astro:content";
import { glob } from "astro/loaders";

const changelog = defineCollection({
  loader: glob({ pattern: "**/*.md", base: "./src/content/changelog" }),
  schema: z.object({
    title: z.string(),
    date: z.date(),
    tag: z.enum(["feature", "fix", "improvement"]),
  }),
});

export const collections = { changelog };
