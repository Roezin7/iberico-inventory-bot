const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes("render.com")
    ? { rejectUnauthorized: false }
    : undefined,
});

async function withTransaction(run) {
  const client = await pool.connect();

  try {
    await client.query("begin");
    const result = await run(client);
    await client.query("commit");
    return result;
  } catch (error) {
    try {
      await client.query("rollback");
    } catch (_) {}
    throw error;
  } finally {
    client.release();
  }
}

module.exports = {
  query: (text, params) => pool.query(text, params),
  withTransaction,
};
