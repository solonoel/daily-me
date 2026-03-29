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
    const { action, topicID, topic, categoryID, isActive, sequence, sequences, userID = 1 } = req.body;

    if (action === 'add') {
      const result = await pool.request()
        .input('UserID', sql.Int, userID)
        .input('CategoryID', sql.Int, categoryID || null)
        .input('Topic', sql.NVarChar(500), topic)
        .input('Sequence', sql.Int, sequence || 99)
        .query(`
          INSERT INTO [HeadlineTopic] (UserID, CategoryID, Topic, IsActive, Sequence, CreatedDate)
          VALUES (@UserID, @CategoryID, @Topic, 'Y', @Sequence, GETDATE());
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
        .input('Sequence', sql.Int, sequence || 99)
        .input('UserID', sql.Int, userID)
        .query(`
          UPDATE [HeadlineTopic]
          SET Topic = @Topic, CategoryID = @CategoryID, IsActive = @IsActive, Sequence = @Sequence
          WHERE TopicID = @TopicID AND UserID = @UserID
        `);
      context.res = {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ success: true })
      };

} else if (action === 'reorder') {
      for (const s of sequences) {
        await pool.request()
          .input('TopicID', sql.Int, s.topicID)
          .input('Sequence', sql.Int, s.sequence)
          .input('UserID', sql.Int, userID)
          .query(`UPDATE [HeadlineTopic] SET Sequence = @Sequence WHERE TopicID = @TopicID AND UserID = @UserID`);
      }
      context.res = { status:200, headers:{'Content-Type':'application/json'}, body: JSON.stringify({ success: true }) };

    } else if (action === 'delete') {
      await pool.request()
        .input('TopicID', sql.Int, topicID)
        .query(`UPDATE [Headline] SET TopicID = NULL WHERE TopicID = @TopicID`);
      await pool.request()
        .input('TopicID', sql.Int, topicID)
        .input('UserID', sql.Int, userID)
        .query(`DELETE FROM [HeadlineTopic] WHERE TopicID = @TopicID AND UserID = @UserID`);
      context.res = { status:200, headers:{'Content-Type':'application/json'}, body: JSON.stringify({ success: true }) };
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