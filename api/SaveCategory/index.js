const sql = require('mssql');

const config = {
  server: 'brunsusa-sql.database.windows.net',
  database: 'DailyMeDB',
  user: 'noeladmin',
  password: process.env.DB_PASSWORD,
  options: {
    encrypt: true,
    trustServerCertificate: false,
    connectTimeout: 60000,
    requestTimeout: 60000
  }
};

module.exports = async function(context, req) {
  try {
    const pool = await sql.connect(config);
    const { categoryID, isActive, userID = 1 } = req.body;

    await pool.request()
      .input('CategoryID', sql.Int, categoryID)
      .input('IsActive', sql.Char(1), isActive ? 'Y' : 'N')
      .input('UserID', sql.Int, userID)
      .query(`
        UPDATE [Category]
        SET IsActive = @IsActive
        WHERE CategoryID = @CategoryID AND UserID = @UserID
      `);

    context.res = {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ success: true })
    };
  } catch(err) {
    context.res = { status: 500, body: 'Error: ' + err.message };
  }
};