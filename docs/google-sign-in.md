# Google sign-in

Signed in with Google, every computer signed in to the same account keeps its notes under one
folder, `people/google-<id>/`, in each paper. With the library on OneDrive, all of them show the
same margin notes, marks, ink and side notes. Signed out, each computer keeps its notes under its
own random id, as before.

Sign-in only proves who you are (scopes `openid email profile`). The app asks for no access to your
Google data and stores no token; only the account's id, name and email go into `settings.json`.

## How it works

1. The account button at the top of the left rail → **Sign in with Google** opens Google's page in your browser.
2. Google sends the browser back to a one-off server on `127.0.0.1` with a code (OAuth for installed
   apps, with PKCE); the app swaps it for an ID token and reads the account from it.
3. This computer's own notes are moved into the account's folder in every library it knows.
4. Notes another computer made before it signed in show under "other identities" in the same
   section, and can be moved in there.

Moving joins by id and never deletes: where both sides have a note, mark or stroke with the same id,
the account's copy is kept; a file present on both sides is kept under a new name.

## Setting up the Google client (once)

The app needs an OAuth client of type **Desktop app** in a Google Cloud project made for Obelus.
In Google Cloud Console, OAuth now lives under **Google Auth Platform** (left menu), with the pages
Overview, Branding, Audience, Clients and Data Access.

1. **Pick the right project.** Open <https://console.cloud.google.com/auth/overview>. The project
   picker at the top left must say **Obelus**. Google opens the last project you used, so check this
   every time. If Overview says "Google Auth Platform not configured yet", press **Get started**:
   - App information: app name `Obelus`, user support email: yours.
   - Audience: **External**.
   - Contact information: your email. Then agree and **Create**.
2. **Branding.** Check the name and support email. Optionally add the home page
   (`https://github.com/Pawcharz/obelus-paper-reader`). Leave the logo empty: a logo makes Google
   require brand verification.
3. **Data Access → Add or remove scopes**: tick `openid`, `.../auth/userinfo.email` and
   `.../auth/userinfo.profile`, then **Update** and **Save**. These are non-sensitive scopes, so no
   app verification is needed.
4. **Clients → Create client → Application type: Desktop app**, name `Obelus desktop` → **Create**.
   Download the JSON from the dialog (it is shown only now; later you can add a new secret).
5. **Audience → Publish app → Confirm.** The status changes from *Testing* to *In production*.
   While in Testing only listed test users can sign in, and Google caps such an app at 100 users
   for the project's lifetime.
6. **Your own PC (optional).** To use the client before a release has it built in, save the JSON as
   `%APPDATA%\Obelus\google-oauth.json` (`paper-reader` before 0.3.1): a file there wins over the client built into the app.
7. **Build it into the installers.** In the public repo (`Pawcharz/obelus-paper-reader`) → Settings
   → Secrets and variables → Actions, add `MAIN_VITE_GOOGLE_CLIENT_ID` and
   `MAIN_VITE_GOOGLE_CLIENT_SECRET` from the JSON (`client_id`, `client_secret`). Or, from a terminal:
   `gh secret set MAIN_VITE_GOOGLE_CLIENT_ID -R Pawcharz/obelus-paper-reader` (it asks for the value).
   `release.yml` passes them to the build.
8. **Try it.** Sign in on two computers with the same account and check the notes move into one
   folder.

Other ways to give the app a client, first found wins: the environment variables
`OBELUS_GOOGLE_CLIENT_ID` and `OBELUS_GOOGLE_CLIENT_SECRET`; then the file above; then the values
built in at build time.

Google calls a desktop client's secret a secret, but an installed app cannot hide it; PKCE is what
protects the sign-in.

## Not done yet

- The library still travels by OneDrive: the account names whose notes they are, it does not store
  them. Each computer still adds the library folder once.
- Another provider, such as an Obelus account of its own, would add a value to `AccountProvider`
  and a sign-in module next to `src/main/auth/google.ts`; the folder becomes `<provider>-<id>`.
