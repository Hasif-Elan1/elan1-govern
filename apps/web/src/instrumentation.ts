// Runs once when the server starts. A missing or weak secret stops the server here.
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./instrumentation-node");
  }
}
