/** @type {import('next').NextConfig} */
const nextConfig = {
  // Keep the ASR stack out of the bundler; it runs natively on the server.
  serverExternalPackages: ["@huggingface/transformers", "onnxruntime-node", "sharp"],
  // Prevent Next.js from inferring a parent dir as the workspace root
  // when a stray package-lock.json exists above the project.
  outputFileTracingRoot: process.cwd(),
};

export default nextConfig;
