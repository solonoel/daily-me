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
    const { action, categoryID, name, isActive, headlines, myWords, sequence, userID = 1 } = req.body;

    if (action === 'add') {
      const result = await pool.request()
        .input('UserID', sql.Int, userID)
        .input('Name', sql.NVarChar(100), name)
        .input('IsActive', sql.Char(1), 'Y')
        .input('Headlines', sql.Char(1), headlines ? 'Y' : 'N')
        .input('MyWords', sql.Char(1), myWords ? 'Y' : 'N')
        .input('Sequence', sql.Int, sequence || 99)
        .query(`
          INSERT INTO [Category] (UserID, Name, IsActive, Headlines, MyWords, Sequence, CreatedDate)
          VALUES (@UserID, @Name, @IsActive, @Headlines, @MyWords, @Sequence, GETDATE());
          SELECT SCOPE_IDENTITY() AS CategoryID;
        `);
      context.res = {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ success: true, categoryID: result.recordset[0].CategoryID })
      };

    } else if (action === 'update') {
      await pool.request()
        .input('CategoryID', sql.Int, categoryID)
        .input('UserID', sql.Int, userID)
        .input('Name', sql.NVarChar(100), name)
        .input('IsActive', sql.Char(1), isActive ? 'Y' : 'N')
        .input('Headlines', sql.Char(1), headlines ? 'Y' : 'N')
        .input('MyWords', sql.Char(1), myWords ? 'Y' : 'N')
        .input('Sequence', sql.Int, sequence || 99)
        .query(`
          UPDATE [Category]
          SET Name = @Name, IsActive = @IsActive, Headlines = @Headlines,
              MyWords = @MyWords, Sequence = @Sequence
          WHERE CategoryID = @CategoryID AND UserID = @UserID
        `);
      context.res = {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ success: true })
      };

    } else if (action === 'toggle') {
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

    } else if (action === 'delete') {
      await pool.request()
        .input('CategoryID', sql.Int, categoryID)
        .input('UserID', sql.Int, userID)
        .query(`
          UPDATE [Category]
          SET IsActive = 'N'
          WHERE CategoryID = @CategoryID AND UserID = @UserID
        `);
      context.res = {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ success: true })
      };
    }
  } catch(err) {
    context.res = { status: 500, body: 'Error: ' + err.message };
  }
};