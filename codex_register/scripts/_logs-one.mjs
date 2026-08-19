import pg from "pg";
const id = Number(process.argv[2]||4082);
const c = new pg.Client({connectionString:"postgresql://postgres:123456@192.168.1.126:5432/all_register"});
await c.connect();
const {rows} = await c.query(`SELECT ts, left(line,190) line FROM mailbox_logs WHERE mailbox_id=$1 ORDER BY id`, [id]);
for (const r of rows) console.log(new Date(Number(r.ts)).toISOString().slice(11,19), r.line);
await c.end();
