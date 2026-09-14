import { defineCollection, z } from 'astro:content';

const changelog = defineCollection({
  type: 'content',
  schema: z.object({
    title: z.string(),
    date: z.date(),
    tag: z.enum(['feature', 'fix', 'improvement']),
  }),
});

export const collections = { changelog };
