// Test-only stand-in for Astro's `astro:transitions/client` virtual module, which
// only exists inside an Astro build. Aliased in vitest.config.ts so components that
// import `navigate` are loadable under vitest; tests mock this module to assert on it.
export function navigate(_href: string): void {}
