// Re-export the server collection so `@/.source` resolves correctly.
// fumadocs-mdx generates this directory but doesn't create an index;
// Next.js webpack needs an index to resolve the bare directory import.
export { docs } from "./server";
