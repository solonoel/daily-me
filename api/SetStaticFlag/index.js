// SetStaticFlag - mark a My Source or a Keyword as static (ignored when deciding if a menu is empty)
// POST body: { userID, type: 'source' | 'keyword', id, isStatic }
const sql = require('mssql');
const config = {
  server: 'brunsusa-sql.database.windows.net', database: 'DailyMeDB', user: 'noeladmin',
  password: process.env.DB_PASSWORD,
  options: { encrypt: true, trustServerCertificate: false, connectTimeout: 60000, requestTimeout: 60000 }
};
module.exports = async function (context, req) {
  try {
    const b = req.body || {};
    const userID = parseInt(b.userID);
    const id = parseInt(b.id);
    if (!userID || !id) {
      context.res = { status: 400, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'userID and id required' }) };
      return;
    }
    const pool = await sql.connect(config);
    const q = b.type === 'keyword'
      ? `UPDATE HeadlineKeyword SET IsStatic = @V WHERE KeywordID = @ID AND UserID = @U`
      : b.type === 'source'
        ? `UPDATE UserOwnedSource SET IsStatic = @V WHERE UserOwnedSourceID = @ID AND UserID = @U`
        : null;
    if (!q) {
      context.res = { status: 400, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Unknown type' }) };
      return;
    }
    const r = await pool.request().input('V', sql.Bit, !!b.isStatic).input('ID', sql.Int, id).input('U', sql.Int, userID).query(q);
    context.res = { status: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ success: r.rowsAffected[0] === 1 }) };
  } catch (err) {
    context.res = { status: 500, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: err.message }) };
  }
};
