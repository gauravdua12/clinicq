/** Static export served by the Fastify server (one process, docs/ARCHITECTURE.md §7). */
const config = {
  output: "export",
  basePath: process.env.NEXT_PUBLIC_BASE_PATH || "",
  trailingSlash: false,
  images: { unoptimized: true },
  devIndicators: false,
};
export default config;
