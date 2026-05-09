const fs = require('fs');
let code = fs.readFileSync('api/SaveUserSettings/index.js', 'utf8');
code = code.replace(
  "const { userID = 1, recencyDays, maxHeadlines, youTubeMaxResults, categorySettings, disableYoutubeToday } = req.body;",
  "const { userID = 1, recencyDays, maxHeadlines, youTubeMaxResults, otherHeadlinesPerKeyword, categorySettings, disableYoutubeToday } = req.body;"
);
code = code.replace(
  "input('YouTubeMaxResults', sql.Int, youTubeMaxResults || 3)",
  "input('YouTubeMaxResults', sql.Int, youTubeMaxResults || 3)\n        .input('OtherHeadlinesPerKeyword', sql.Int, otherHeadlinesPerKeyword ?? 3)"
);
code = code.replace(
  "SET RecencyDays = @RecencyDays, MaxHeadlines = @MaxHeadlines, YouTubeMaxResults = @YouTubeMaxResults,\n              LastYouTubeFetch = NULL",
  "SET RecencyDays = @RecencyDays, MaxHeadlines = @MaxHeadlines, YouTubeMaxResults = @YouTubeMaxResults,\n              OtherHeadlinesPerKeyword = @OtherHeadlinesPerKeyword,\n              LastYouTubeFetch = NULL"
);
fs.writeFileSync('api/SaveUserSettings/index.js', code, 'utf8');
console.log('Done');
