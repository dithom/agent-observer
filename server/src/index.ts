import { createApp } from "./app";

const { server, shutdown } = createApp();

process.on("SIGTERM", () => {
  shutdown();
  process.exit(0);
});
process.on("SIGINT", () => {
  shutdown();
  process.exit(0);
});

server.listen(0, () => {
  const addr = server.address();
  if (addr && typeof addr === "object") {
    console.log(`Agent Observer server running on port ${addr.port}`);
  }
});
