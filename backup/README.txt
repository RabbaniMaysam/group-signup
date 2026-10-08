Backups of the database (group sign-up tool)
============================================

Where the data lives
  Everything of the tool (classes, groups, claims, requests, the action log,
  and the undo snapshots) is stored in the Cloudflare D1 database
  "group-signup". It is persistent: signing out or closing the page changes
  nothing. Cloudflare also keeps its own point-in-time history of the database
  for 30 days (D1 Time Travel), restorable with:
    npx wrangler d1 time-travel restore group-signup --timestamp <ISO time>

  Until 2026-10-05 the same database also held the attendance tool. That tool
  has its own repository, database, and backup since (backups\attendance). The
  old attendance tables (att_classes, att_marks, att_answers) and log rows
  (class 'att:' + key) remain in this database, unused, so they also appear in
  the dumps here.

Daily dump into Google Drive
  backup.ps1 exports the whole database as SQL into backups\group-signup\ of
  the tools folder that contains this repository
  (F:\GDriveMay\Maysam\01_online_tools\backups\group-signup). That folder is in
  Google Drive, so the dumps are synced, and it is outside the repository, so
  they never reach the public repository. A dump is about 0.5 MB. The newest 90 dumps are kept,
  plus the first dump of every month, which is never deleted (12 files a year).
  The script first refreshes the Cloudflare sign-in token with a harmless
  wrangler call (the first call of the night finds the token expired, and the
  export requested in that same call was refused with "Authentication error
  [code: 10000]" at 03:00 on 2026-10-04 to 2026-10-07, while the next call
  worked). A failed export is then retried up to five attempts, 2 minutes
  apart; last_run.log has the output of every attempt of the last run. If all
  five fail, the run writes BACKUP_FAILED.txt into that folder (the next good
  run deletes it). The scheduled task stops the script after 1 hour (its
  earlier 10-minute limit ended the script during the first retry wait).

  After each dump, export_csv.mjs writes readable CSV copies of it into the
  csv\ subfolder of that folder (replacing the previous set): per class the
  groups, the roster, and the log. For an older day, from this repository's folder:
    node --no-warnings backup/export_csv.mjs "<path of that day's .sql file>"

  Scheduled task "group-signup backup" runs it daily at 03:00 (and on the next
  start-up if the PC was off; not on battery). Manage it in Task Scheduler, or:
    schtasks /Query /TN "group-signup backup"
    schtasks /Run   /TN "group-signup backup"
    schtasks /Delete /TN "group-signup backup" /F

Restoring a dump
  From the worker/ folder:
    npx wrangler d1 execute group-signup --remote --file "../../backups/group-signup/<file>.sql"
  The dump recreates the tables, so drop them first if they exist
  (npx wrangler d1 execute group-signup --remote --command "DROP TABLE classes; DROP TABLE log; DROP TABLE snapshots; DROP TABLE att_classes; DROP TABLE att_marks; DROP TABLE att_answers"),
  or restore a single class by copying its INSERT lines.
