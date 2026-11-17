// `npm run seed` — wipe and regenerate the demo portfolio.
import { openDb } from "./db.ts";
import { seedDatabase } from "./seed.ts";

const { rw, file } = openDb();
const s = seedDatabase(rw);
console.log(`Seeded ${file}: ${s.projects} projects, ${s.progressReports} monthly reports, ${s.milestones} milestones, ${s.issues} issues.`);
