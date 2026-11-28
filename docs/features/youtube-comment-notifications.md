# YouTube comment notifications

PortOS can check a YouTube channel for new published comments and replies on its videos. Each notification appears in the PortOS bell's history and opens the channel's YouTube Studio comments inbox. For delivery away from PortOS, enable **YouTube Comments** in the Telegram notification forwarding settings.

1. Enable [YouTube Data API v3](https://developers.google.com/youtube/v3/getting-started) in a Google Cloud project and create an API key restricted to that API.
2. Copy your channel ID from [YouTube advanced account settings](https://www.youtube.com/account_advanced). Add these settings to the PortOS install's local `.env` and restart the server.

   ```dotenv
   YOUTUBE_COMMENT_CHANNEL_ID=<UC channel ID>
   YOUTUBE_COMMENT_API_KEY=<YouTube Data API key>
   # Optional. Default 60 minutes. Allowed range is 5–1440.
   YOUTUBE_COMMENT_INTERVAL_MINUTES=60
   ```

Monitoring starts when PortOS first starts with this channel configured. Existing comments stay quiet. After a restart, checks resume from the saved checkpoint, so comments published during downtime can still be detected. Published comments are limited to those visible to the API key. Private-video comments and comments held for review require a different access method. Comments the API first exposes more than 24 hours after their publication timestamp may be missed after a successful check has moved past them.

The watcher makes outbound API requests. Each check paginates the channel's threads and fetches additional reply pages where needed, including replies to older threads. On larger channels, increase the interval to fit your [YouTube API quota](https://developers.google.com/youtube/v3/determine_quota_cost). Check the server logs for the `youtube-comment-watch` scheduler event if notifications stop arriving. HTTP 403 can indicate an API key restriction or an exhausted quota. A failed API scan leaves the last successful checkpoint in place.

To stop the watcher, remove both YouTube comment settings and restart PortOS.
