import("../server/migrate.ts").then(m => m.runMigrations()).then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
