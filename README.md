# Group sign-up

A web page where students form groups and claim one dataset and one presentation topic per group, first come, first served.

- `docs/` holds the two pages, served by GitHub Pages: `index.html` for students and `admin.html` for the instructor.
- `worker/` is the backend, a Cloudflare Worker with a D1 database.
- `backup/` has the daily dump of the database and its restore notes.
- `test/` holds the checks (see Tests).

No student data is stored in this repository. Each class's roster, groups, claims, and activity log are in the database.

## Rules the backend enforces

- Only emails on the class roster can use the student page. Students sign in with Google.
- A student creates a new group or asks to join an existing one. The student who created the group (the leader) approves or declines each request.
- A group has at most 3 members: the leader plus up to two approved students.
- Only the leader claims the dataset and topic, and only when the group has at least 2 members.
- A claimed dataset or topic is unavailable to other groups. A leader may switch to any unclaimed item, which releases the old one.
- If the leader leaves, the member who joined earliest becomes leader. A group whose last member leaves is deleted and its claims are released.
- The number of groups is capped (20 by default). Students are not shown the cap.
- After the deadline nothing can be changed from the student page.

The limits and the deadline are settings of each class. The tool sends no email. A leader learns of a join request by opening the page.

## Instructor page (`admin.html`)

Only the accounts in the Worker's `ADMIN_EMAILS` secret can use it. Neither the deadline nor the size limits apply to changes made there.

| Tab | Tasks |
|---|---|
| Overview | Student link, title, deadline, limits, downloads of the groups and the full log, delete the class |
| Roster | Import the roster (see Roster files), add or remove one student, move a student to a group |
| Groups | Change the leader, assign or release a dataset or topic, delete a group |
| Datasets, Topics | Add, edit, or remove catalog items |
| Log | Every sign-in, action, and refused attempt with its reason, time, and account |

On the student page, an instructor account sees the whole board and can preview and act as any student. Preview actions are marked in the log.

## Roster files

The import (`parseRoster` in `worker/src/rules.js`) reads the Canvas gradebook export, with a "Student" column ("Last, First") and a "SIS Login ID" column (the address before the @, completed with `@montclair.edu`; the "Points Possible" row and Canvas's test student are skipped), or a CSV with first name, last name, and email columns in any order. Addresses are lowercased, and `@mail.montclair.edu` is stored as `@montclair.edu`; a student may sign in with either form. The domain rule is the one line `canonEmail` in `rules.js`.

## Several classes

One backend serves every class. A class is created on the instructor page with a short key, and its student link is the page address followed by `?c=` and the key. A new class starts from the standard catalog in `worker/src/seed.js` or from a copy of an existing class's catalog and limits.

## Attendance tool

Until 2026-10-05 this repository also held the attendance tool. It has its own repository, Worker, and database since: RabbaniMaysam/attendance, at https://rabbanimaysam.github.io/attendance/. The old pages `docs/attendance.html` and `docs/attendance_admin.html` forward to the new addresses, keeping the class key, so old links and QR codes still work. The attendance tables and log rows written before the move remain in this database, unused.

## Sign-in

The pages use the "Sign in with Google" button. The Worker verifies Google's signature on the sign-in token and that the token was issued for this tool's client ID, then answers with a session token of its own (signed with the `SESSION_SECRET` secret, valid 180 days), which the page keeps in the browser's storage and sends from then on, so a student signs in with Google once a semester per browser and later only opens the link; "Sign out" deletes the token. Without the secret, the pages fall back to Google's token, which lasts an hour. Changing the secret signs every browser out. The client ID is a public identifier created once in Google Cloud Console (type "Web application", with the page's origin, for example `https://USERNAME.github.io`, under "Authorized JavaScript origins", and the student page's full address, `.../index.html`, under "Authorized redirect URIs"). The redirect URI serves the "Choose or add the university account" link under the button: a browser signed into one personal Google account is signed in with it by the button without a choice, so the link opens Google's account chooser in the same tab (`prompt=select_account`), which returns to the page with the ID token in the address's fragment; the page keeps it only if the nonce it stored before leaving matches. It is the value of `GOOGLE_CLIENT_ID` in `worker/wrangler.toml`. The tool holds no permission on any Google account.

## Deployment

From `worker/`, with a Cloudflare account:

```
npx wrangler d1 create group-signup          # once; copy the database_id into wrangler.toml
npx wrangler d1 execute group-signup --remote --file schema.sql
npx wrangler secret put ADMIN_EMAILS         # comma-separated instructor emails
npx wrangler secret put SESSION_SECRET       # any long random string (signs the session tokens)
npx wrangler deploy
```

Then write the Worker's address into `docs/config.js`.

## Tests

- `node test/test_rules.mjs` checks the rules on an in-memory class.
- `node test/test_worker.mjs` checks a local copy of the Worker end to end, including simultaneous claims of one item (its header lists the commands).
- `node test/check_pages.mjs` checks that the page scripts parse and reference no undeclared names.
