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
    const { action, topicID, topic, categoryID, isActive, userID = 1 } = req.body;

    if (action === 'add') {
      const result = await pool.request()
        .input('UserID', sql.Int, userID)
        .input('CategoryID', sql.Int, categoryID || null)
        .input('Topic', sql.NVarChar(500), topic)
        .query(`
          INSERT INTO [HeadlineTopic] (UserID, CategoryID, Topic, IsActive, CreatedDate)
          VALUES (@UserID, @CategoryID, @Topic, 'Y', GETDATE());
          SELECT SCOPE_IDENTITY() AS TopicID;
        `);
      context.res = {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ success: true, topicID: result.recordset[0].TopicID })
      };

    } else if (action === 'update') {
      await pool.request()
        .input('TopicID', sql.Int, topicID)
        .input('CategoryID', sql.Int, categoryID || null)
        .input('Topic', sql.NVarChar(500), topic)
        .input('IsActive', sql.Char(1), isActive ? 'Y' : 'N')
        .input('UserID', sql.Int, userID)
        .query(`
          UPDATE [HeadlineTopic]
          SET Topic = @Topic, CategoryID = @CategoryID, IsActive = @IsActive
          WHERE TopicID = @TopicID AND UserID = @UserID
        `);
      context.res = {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ success: true })
      };

    } else if (action === 'delete') {
      await pool.request()
        .input('TopicID', sql.Int, topicID)
        .input('UserID', sql.Int, userID)
        .query(`
          DELETE FROM [HeadlineTopic]
          WHERE TopicID = @TopicID AND UserID = @UserID
        `);
      context.res = {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ success: true })
      };

    } else {
      context.res = { status: 400, body: 'Unknown action' };
    }
  } catch(err) {
    context.res = { status: 500, body: 'Error: ' + err.message };
  }
};