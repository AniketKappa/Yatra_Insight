// Entry point: open (and seed on first run) the database, then serve.
import { openDb } from "./db.ts";
import { seedDatabase } from "./seed.ts";
import { createApp } from "./app.ts";
import { MODEL, llmConfigured } from "./llm/claude.ts";

const db = openDb();
const count = (db.rw.prepare("SELECT COUNT(*) AS n FROM projects").get() as { n: number }).n;
if (count === 0) {
  const s = seedDatabase(db.rw);
  console.log(`First run: seeded ${s.projects} demo projects (${s.progressReports} monthly reports).`);
}

const { app } = createApp(db);
// --port wins (used by `npm run dev`, so a PORT meant for the web dev server
// can't collide with the API), then API_PORT, then PORT, then 8787.
const portArg = process.argv.find((a) => a.startsWith("--port="))?.split("=")[1];
const port = Number(portArg || process.env.API_PORT || process.env.PORT) || 8787;
const server = app.listen(port, () => {
  console.log(`Yatra Insight API on http://localhost:${port}`);
  console.log(llmConfigured() ? `Claude enabled (${MODEL}).` : "No ANTHROPIC_API_KEY set — running in offline analysis mode.");
});

const shutdown = () => {
  server.close(() => {
    db.rw.close();
    if (db.ro !== db.rw) db.ro.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 3000).unref();
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
