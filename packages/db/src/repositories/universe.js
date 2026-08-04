export function createUniverseRepo(client) {
  async function listActive() {
    const { rows } = await client.query(
      `SELECT symbol, exchange, sector, name, active
       FROM universe WHERE active = TRUE ORDER BY symbol`,
    );
    return rows;
  }

  async function upsertMany(symbols) {
    if (symbols.length === 0) return 0;
    let count = 0;
    for (const s of symbols) {
      await client.query(
        `INSERT INTO universe (symbol, exchange, sector, name, active)
         VALUES ($1, $2, $3, $4, TRUE)
         ON CONFLICT (symbol) DO UPDATE
           SET exchange = EXCLUDED.exchange,
               sector   = EXCLUDED.sector,
               name     = EXCLUDED.name,
               active   = TRUE`,
        [s.symbol, s.exchange, s.sector ?? null, s.name ?? null],
      );
      count++;
    }
    return count;
  }

  return { listActive, upsertMany };
}
