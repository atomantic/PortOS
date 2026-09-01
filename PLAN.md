# PLAN

- [x] [today-agenda-dashboard-widget] Today's Agenda dashboard widget — glanceable list of today's remaining calendar events (new `GET /api/calendar/agenda` with a timezone-correct day window, gated on a connected calendar account, seeded into the Everything and Morning Review layouts)
- [x] [on-this-day-dashboard-widget] On This Day dashboard widget — resurfaces Brain journal entries, memories, and ideas written on today's date in past years (new `GET /api/brain/on-this-day` with timezone-correct date matching, journal rows deep-link into the Daily Log via a new `?date=` param, seeded into the Everything and Morning Review layouts)
