import { defineConfig, loadEnv } from "vite";
import { jevMiddleware } from "./server/jev.js";

export default defineConfig(({ mode }) => {
  const env = { ...process.env, ...loadEnv(mode, process.cwd(), "") };
  const network = {
    host: env.JEV_HOST || "localhost",
    port: 5173,
    strictPort: true,
    allowedHosts: (env.JEV_ALLOWED_HOSTS || "").split(",").filter(Boolean),
  };
  // One middleware instance so dev and preview share the concurrency cap.
  const jev = jevMiddleware(env);
  return {
    server: network,
    preview: network,
    plugins: [
      {
        name: "jev-server",
        configureServer(server) {
          server.middlewares.use(jev);
        },
        configurePreviewServer(server) {
          server.middlewares.use(jev);
        },
      },
    ],
    build: {
      rolldownOptions: {
        input: { main: "index.html", play: "play.html" },
        output: {
          codeSplitting: {
            groups: [{ name: "three", test: /node_modules\/three/ }],
          },
        },
      },
    },
  };
});
