import { startServer } from "./app.js";

process.on("unhandledRejection", (reason) => {
  console.error("Unhandled promise rejection:", reason);
});

process.on("uncaughtException", (error) => {
  console.error("Uncaught exception:", error);
  process.exit(1);
});

try {
  startServer();
} catch (error) {
  console.error("Unable to start MiMo OpenAI Bridge:", error);
  process.exit(1);
}
