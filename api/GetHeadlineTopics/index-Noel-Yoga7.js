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
    const userID = parseInt(req.query.userID || '1');

    const result = await pool.request()
      .input('UserID', sql.Int, userID)
      .query(`
        SELECT t.TopicID, t.CategoryID, t.Topic, t.IsActive, t.Sequence,
               t.GroupLabel, t.ImageURL, c.Name AS CategoryName
        FROM [HeadlineTopic] t
        LEFT JOIN [Category] c ON t.CategoryID = c.CategoryID
        WHERE t.UserID = @UserID
        ORDER BY t.Sequence, t.Topic
      `);

    context.res = {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(result.recordset)
    };
  } catch (err) {
    context.res = { status: 500, body: 'Error: ' + err.message };
  }
};