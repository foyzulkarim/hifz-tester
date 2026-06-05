/** @type {import('next').NextConfig} */
const nextConfig = {
  // Keep the ASR stack out of the bundler; it runs natively on the server.
  serverExternalPackages: ["@huggingface/transformers", "onnxruntime-node", "sharp"],
};

export default nextConfig;
